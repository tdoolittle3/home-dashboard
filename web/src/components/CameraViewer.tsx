import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraRef } from '../types';

interface CameraViewerProps {
  cameras: CameraRef[];
  /** Index into `cameras` of the one being shown. */
  index: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}

/** How long a dropped stream stays on its fallback still before reconnecting. */
const STREAM_RETRY_MS = 5_000;

/** A horizontal move at least this long, and clearly more sideways than down, is a swipe. */
const SWIPE_MIN_PX = 48;

/** Any less movement than this still counts as a tap. */
const TAP_MAX_PX = 12;

/** Two taps this close together are a double tap (rewind), not two pause toggles. */
const DOUBLE_TAP_MS = 300;

/** How far a double tap steps back into the buffered live stream. */
const REWIND_S = 10;

/*
 * The Fullscreen API is uneven on mobile: iPhone Safari does not offer it at
 * all for anything but <video>, and older WebKit and Android browsers only
 * ship it with the webkit prefix. So every call goes through these helpers,
 * and where no variant exists the overlay itself is the full screen. The
 * iPhone-only <video>-native player is deliberately not used: it takes over
 * the whole screen, which would make the swipe and tap gestures unreachable,
 * and it only exists for cameras whose codec the browser can play.
 */
interface WebkitElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface WebkitDocument extends Document {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

const doc = document as WebkitDocument;

const FULLSCREEN_SUPPORTED = document.fullscreenEnabled || doc.webkitFullscreenEnabled === true;

/**
 * Safari (and every iOS browser, all WebKit) plays HLS natively in a <video>;
 * everything else gets go2rtc's endless fMP4, which is lower latency anyway.
 */
const NATIVE_HLS = document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';

function currentFullscreenElement(): Element | null {
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function requestFullscreenOn(node: HTMLElement): void {
  const target = node as WebkitElement;
  const request = target.requestFullscreen?.bind(target) ?? target.webkitRequestFullscreen?.bind(target);
  // Refused in some embedded contexts; the overlay still stands on its own.
  void Promise.resolve(request?.()).catch(() => undefined);
}

function exitFullscreen(): void {
  const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(doc);
  void Promise.resolve(exit?.()).catch(() => undefined);
}

/** Snap a live <video> back to its newest frame, e.g. when resuming from pause. */
function jumpToLive(video: HTMLVideoElement): void {
  try {
    const { seekable } = video;
    if (seekable.length > 0) {
      video.currentTime = Math.max(seekable.end(seekable.length - 1) - 0.3, 0);
    }
  } catch {
    // Not seekable (yet); playback just continues from wherever it is.
  }
}

/**
 * Full-screen live viewer, driven by gestures instead of buttons: the tile's
 * expand button opens it straight into browser fullscreen where the platform
 * has one (everywhere but iPhone, where the overlay itself fills the screen).
 *
 *   tap          pause / resume (resume snaps back to live)
 *   double tap   rewind ~10 s into the buffered stream, where one exists
 *   swipe ←/→    previous / next camera
 *   swipe ↓      close - as do the ✕, Escape, and leaving browser fullscreen
 *
 * The panel thumbnails stay cheap polled stills; only here, where someone is
 * actually watching, does a live connection open. The live element is a real
 * <video> fed by go2rtc through the backend (native HLS on WebKit, endless
 * fMP4 elsewhere); a browser that cannot play the camera's codec, or a camera
 * go2rtc does not carry, drops to the MJPEG stream, and a hidden tab or a
 * dropped MJPEG stream fall back to a still. Pausing leaves the <video>
 * mounted so its frozen frame - and the buffer a rewind needs - survive.
 */
export function CameraViewer({ cameras, index, onSelect, onClose }: CameraViewerProps) {
  const camera = cameras[index];
  const [tick, setTick] = useState(() => Date.now());
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const [streamDown, setStreamDown] = useState(false);
  // A browser that cannot play the camera's codec (or a camera go2rtc does not
  // carry) fails the <video> once; MJPEG takes over for the rest of the visit.
  const [videoDown, setVideoDown] = useState(false);
  // Bumped to force a new connection when the stream needs a reconnect.
  const [streamKey, setStreamKey] = useState(0);
  // A short confirmation ("‹ 10s") after a gesture with no visible effect of its own.
  const [toast, setToast] = useState<string | null>(null);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Whether browser fullscreen was actually entered, so that only a real
  // fullscreen exit closes the viewer - not the initial request being refused.
  const enteredFullscreenRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const streaming = !hidden && !streamDown;

  const togglePaused = useCallback(() => {
    const next = !pausedRef.current;
    const video = videoRef.current;
    if (video) {
      if (next) {
        video.pause();
      } else {
        jumpToLive(video);
        void video.play().catch(() => undefined);
      }
    }
    // The MJPEG and still fallbacks freeze/thaw on a frame fetched now.
    setTick(Date.now());
    setPaused(next);
  }, []);

  const rewind = useCallback(() => {
    const video = videoRef.current;
    if (!video) return; // MJPEG and stills have no buffer to step back into.
    try {
      const { seekable } = video;
      if (seekable.length === 0) return;
      const target = Math.max(video.currentTime - REWIND_S, seekable.start(0) + 0.25);
      if (target >= video.currentTime - 0.5) return; // already at the buffer's edge
      video.currentTime = target;
      setToast(`‹ ${Math.round(video.currentTime - target) || REWIND_S}s`);
    } catch {
      // Seeking a live stream is best-effort; at worst nothing happens.
    }
  }, []);

  const step = useCallback(
    (delta: number) => {
      if (cameras.length < 2) return;
      // Wrap in both directions so swiping never dead-ends.
      onSelect((index + delta + cameras.length) % cameras.length);
      setTick(Date.now());
      setPaused(false);
      setStreamDown(false);
      setVideoDown(false);
    },
    [cameras.length, index, onSelect],
  );

  // A hidden tab must not keep Frigate encoding; dropping to the still closes
  // the stream connection, and coming back reopens it. The still is fetched as
  // of the drop, not as of when the viewer opened.
  useEffect(() => {
    const sync = () => {
      setTick(Date.now());
      setHidden(document.visibilityState === 'hidden');
    };
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  // A dropped stream shows its fallback still, then quietly tries again.
  useEffect(() => {
    if (!streamDown) return;
    const timer = setTimeout(() => {
      setStreamDown(false);
      setStreamKey((current) => current + 1);
    }, STREAM_RETRY_MS);
    return () => clearTimeout(timer);
  }, [streamDown]);

  // The rewind confirmation fades on its own.
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 900);
    return () => clearTimeout(timer);
  }, [toast]);

  // Any pending single-tap must not fire after the viewer is gone.
  useEffect(() => {
    return () => {
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    };
  }, []);

  // Move focus in on open and hand it back to the trigger on close, so keyboard
  // users are not dropped at the top of the document.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    overlayRef.current?.focus();
    return () => previous?.focus();
  }, []);

  // The page behind the overlay must not scroll while it is open. overflow:
  // hidden on the body is not enough: iOS Safari ignores it as a scroll lock,
  // and after rotating the phone with it applied can leave the page stuck
  // unscrollable even once it is removed. Pinning the body with position:
  // fixed is the lock WebKit honours; the negative top keeps the page from
  // visually jumping, and close puts the scroll position back.
  useEffect(() => {
    const { style } = document.body;
    const scrollY = window.scrollY;
    const original = {
      position: style.position,
      top: style.top,
      left: style.left,
      right: style.right,
      overflow: style.overflow,
    };
    style.position = 'fixed';
    style.top = `-${scrollY}px`;
    style.left = '0';
    style.right = '0';
    style.overflow = 'hidden';
    return () => {
      style.position = original.position;
      style.top = original.top;
      style.left = original.left;
      style.right = original.right;
      style.overflow = original.overflow;
      window.scrollTo(0, scrollY);
    };
  }, []);

  // Straight into browser fullscreen: the click on the tile's expand button is
  // still a fresh user activation when this mounts, so the request is honoured.
  // Once entered, leaving fullscreen (Escape, F11, a platform gesture) is a way
  // back to the dashboard, so an exit closes the overlay. Prefixed WebKit fires
  // webkitfullscreenchange instead of the standard event.
  useEffect(() => {
    const node = overlayRef.current;
    if (FULLSCREEN_SUPPORTED && node) requestFullscreenOn(node);
    const sync = () => {
      if (currentFullscreenElement() === overlayRef.current) {
        enteredFullscreenRef.current = true;
      } else if (enteredFullscreenRef.current) {
        onCloseRef.current();
      }
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  // Closing while in browser fullscreen goes through the exit, and the change
  // handler above does the rest; everywhere else the overlay just closes.
  const close = useCallback(() => {
    if (currentFullscreenElement()) {
      exitFullscreen();
    } else {
      onCloseRef.current();
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // While in browser fullscreen the first Escape exits that; let the
        // browser handle it, and the fullscreen-change handler closes the rest.
        if (currentFullscreenElement()) return;
        event.preventDefault();
        close();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        step(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      } else if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        togglePaused();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, step, togglePaused]);

  // One pointer pipeline for touch and mouse alike: where the pointer went
  // down and came up decides between swipe, tap and double tap. The single
  // tap waits out the double-tap window so a rewind is not also a pause.
  const onPointerDown = (event: React.PointerEvent) => {
    if (!event.isPrimary) return;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || !event.isPrimary) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (absX >= SWIPE_MIN_PX && absX > absY * 1.5) {
      step(dx < 0 ? 1 : -1);
      return;
    }
    if (dy >= SWIPE_MIN_PX * 1.5 && absY > absX * 1.5) {
      close();
      return;
    }
    if (absX > TAP_MAX_PX || absY > TAP_MAX_PX) return; // a drag that settled nowhere

    const now = performance.now();
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
      rewind();
    } else {
      lastTapRef.current = now;
      tapTimerRef.current = setTimeout(() => {
        tapTimerRef.current = null;
        togglePaused();
      }, DOUBLE_TAP_MS);
    }
  };

  if (!camera) return null;

  const label = camera.label ?? camera.name;
  // The <video> stays mounted while paused: its frozen frame is the pause
  // display, and its buffer is what a rewind steps back into.
  const showVideo = streaming && !videoDown;
  const showMjpeg = streaming && videoDown && !paused;

  return (
    <div
      className="viewer"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${label} camera - tap to pause, double-tap to rewind, swipe to switch cameras`}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="viewer__meta">
        <span className="viewer__name">{label}</span>
        {paused ? (
          <span className="pill">paused</span>
        ) : streamDown ? (
          <span className="pill">reconnecting</span>
        ) : (
          <span className="pill pill--live">live</span>
        )}
      </div>

      <button
        type="button"
        className="viewer__close"
        aria-label="Close"
        onClick={close}
        // A press on the ✕ must not double as a tap-to-pause on the overlay.
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
      >
        ✕
      </button>

      <figure className="viewer__frame">
        {showVideo ? (
          <video
            key={`video-${camera.name}-${streamKey}`}
            ref={videoRef}
            src={`/api/camera/${camera.name}/${NATIVE_HLS ? 'live.m3u8' : 'live.mp4'}?k=${streamKey}`}
            autoPlay
            muted
            playsInline
            aria-label={`Live view of ${label}`}
            // Coming back from a hidden tab remounts the video; a viewer that
            // was paused must not silently resume.
            onLoadedMetadata={(event) => {
              if (pausedRef.current) event.currentTarget.pause();
            }}
            onError={() => setVideoDown(true)}
          />
        ) : showMjpeg ? (
          <img
            key={`stream-${camera.name}-${streamKey}`}
            src={`/api/camera/${camera.name}/stream?h=1080&fps=5&k=${streamKey}`}
            alt={`Live view of ${label}`}
            onError={() => {
              setTick(Date.now());
              setStreamDown(true);
            }}
          />
        ) : (
          <img src={`/api/camera/${camera.name}/snapshot?h=1080&t=${tick}`} alt={`Latest still from ${label}`} />
        )}
      </figure>

      {toast !== null ? (
        <span className="viewer__toast" aria-live="polite">
          {toast}
        </span>
      ) : null}

      {cameras.length > 1 ? (
        <div className="viewer__dots" aria-hidden="true">
          {cameras.map((entry, dot) => (
            <span key={entry.name} className={dot === index ? 'viewer__dot viewer__dot--active' : 'viewer__dot'} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
