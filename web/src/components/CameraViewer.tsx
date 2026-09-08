import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraRef } from '../types';

interface CameraViewerProps {
  camera: CameraRef;
  onClose: () => void;
}

/** How long a dropped stream stays on its fallback still before reconnecting. */
const STREAM_RETRY_MS = 5_000;

/*
 * The Fullscreen API is uneven on mobile: iPhone Safari does not offer it for
 * anything but <video>, and older WebKit and Android browsers only ship it with
 * the webkit prefix. So every call goes through these helpers, and where no
 * variant exists the overlay itself fills the viewport instead.
 */
interface WebkitElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

/** iPhone's only full screen: the native video player, offered on <video> alone. */
interface WebkitVideoElement extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
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

/**
 * Full-screen live viewer with no chrome of its own: the tile's expand button
 * opens it straight into browser fullscreen, and leaving fullscreen — or a
 * click/tap or Escape where fullscreen was refused — returns to the dashboard.
 *
 * The panel thumbnails stay cheap polled stills; only here, where someone is
 * actually watching, does a live connection open. The live element is a real
 * <video> fed by go2rtc through the backend (native HLS on WebKit, endless
 * fMP4 elsewhere); a browser that cannot play the camera's codec, or a camera
 * go2rtc does not carry, drops to the MJPEG stream, and a hidden tab or a
 * dropped MJPEG stream fall back to a still.
 *
 * This is an overlay first and a real Fullscreen API call second: the overlay
 * works everywhere, while browser fullscreen needs a user gesture and is
 * refused in some embedded contexts. On iPhone, where only <video> can go
 * full screen, the native player is tried once the video is ready.
 */
export function CameraViewer({ camera, onClose }: CameraViewerProps) {
  const [tick, setTick] = useState(() => Date.now());
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const [streamDown, setStreamDown] = useState(false);
  // A browser that cannot play the camera's codec (or a camera go2rtc does not
  // carry) fails the <video> once; MJPEG takes over for the rest of the visit.
  const [videoDown, setVideoDown] = useState(false);
  // Bumped to force a new connection when the stream needs a reconnect.
  const [streamKey, setStreamKey] = useState(0);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  // Whether browser fullscreen was actually entered, so that only a real
  // fullscreen exit closes the viewer - not the initial request being refused.
  const enteredFullscreenRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const streaming = !hidden && !streamDown;

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
  // Once entered, leaving fullscreen (Escape, F11, a platform gesture) is the
  // way back to the dashboard, so an exit closes the overlay. Prefixed WebKit
  // fires webkitfullscreenchange instead of the standard event.
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
      if (event.key !== 'Escape') return;
      // While in browser fullscreen the first Escape exits that; let the
      // browser handle it, and the fullscreen-change handler closes the rest.
      if (currentFullscreenElement()) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  // iPhone: no Fullscreen API for the overlay, but the <video> can enter the
  // native player once it has media. The attempt rides on whatever remains of
  // the opening tap's activation - if that has lapsed the overlay, which
  // already fills the viewport, is the full screen. Closing the native player
  // hands back to the dashboard.
  const attachVideo = useCallback((node: HTMLVideoElement | null) => {
    if (!node || FULLSCREEN_SUPPORTED) return;
    const video = node as WebkitVideoElement;
    if (!video.webkitEnterFullscreen) return;
    node.addEventListener(
      'loadedmetadata',
      () => {
        try {
          video.webkitEnterFullscreen?.();
        } catch {
          // Activation expired or player unavailable; the overlay stands.
        }
      },
      { once: true },
    );
    node.addEventListener('webkitendfullscreen', () => onCloseRef.current(), { once: true });
  }, []);

  const label = camera.label ?? camera.name;

  return (
    // Any click or tap is the way out - the viewer has no controls of its own.
    <div
      className="viewer"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${label} camera - click or press Escape to close`}
      tabIndex={-1}
      onClick={close}
    >
      <figure className="viewer__frame">
        {streaming && !videoDown ? (
          <video
            key={`video-${camera.name}-${streamKey}`}
            ref={attachVideo}
            src={`/api/camera/${camera.name}/${NATIVE_HLS ? 'live.m3u8' : 'live.mp4'}?k=${streamKey}`}
            autoPlay
            muted
            playsInline
            aria-label={`Live view of ${label}`}
            onError={() => setVideoDown(true)}
          />
        ) : streaming ? (
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
    </div>
  );
}
