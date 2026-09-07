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

/*
 * The Fullscreen API is uneven on mobile: iPhone Safari does not offer it for
 * anything but <video> (and the stream here is an <img>), and older WebKit and
 * Android browsers only ship it with the webkit prefix. So every call goes
 * through these helpers, and where no variant exists the button is not shown -
 * the overlay already fills the viewport there.
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
 * Full-screen live viewer. The panel thumbnails stay cheap polled stills; only
 * here, where someone is actually watching, does the MJPEG stream run - Frigate
 * encodes per viewer, so streams are opened deliberately and torn down eagerly.
 * Pausing, hiding the tab, or a dropped stream all fall back to a still.
 *
 * This is an overlay first and a real Fullscreen API call second: the overlay
 * works everywhere and can be dismissed with Escape, while browser fullscreen
 * needs a user gesture and is refused in some embedded contexts.
 */
export function CameraViewer({ cameras, index, onSelect, onClose }: CameraViewerProps) {
  const camera = cameras[index];
  const [tick, setTick] = useState(() => Date.now());
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const [streamDown, setStreamDown] = useState(false);
  // Bumped to force a new <img> connection when the stream needs a reconnect.
  const [streamKey, setStreamKey] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const streaming = !paused && !hidden && !streamDown;

  // Refresh the still when frozen; force a reconnect when live.
  const refreshNow = useCallback(() => {
    setTick(Date.now());
    setStreamKey((current) => current + 1);
  }, []);

  // Pausing freezes on a still fetched now, not one from when the viewer opened.
  const togglePaused = useCallback(() => {
    setTick(Date.now());
    setPaused((current) => !current);
  }, []);

  const step = useCallback(
    (delta: number) => {
      if (cameras.length < 2) return;
      // Wrap in both directions so the arrow keys never dead-end.
      onSelect((index + delta + cameras.length) % cameras.length);
      setTick(Date.now());
      setStreamDown(false);
    },
    [cameras.length, index, onSelect],
  );

  // A hidden tab must not keep Frigate encoding; dropping to the still closes
  // the stream connection, and coming back reopens it.
  useEffect(() => {
    const sync = () => setHidden(document.visibilityState === 'hidden');
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
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);

  // The page behind the overlay must not scroll while it is open.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  // Browser fullscreen can also be left with F11 or the platform's own Escape
  // handling, so mirror the document's state rather than tracking our own.
  // Prefixed WebKit fires webkitfullscreenchange instead of the standard event.
  useEffect(() => {
    const sync = () => setIsFullscreen(currentFullscreenElement() === overlayRef.current);
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // While in browser fullscreen the first Escape exits that; let the
        // browser handle it and keep the overlay open.
        if (currentFullscreenElement()) return;
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        step(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      } else if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        togglePaused();
      } else if (event.key === 'r' || event.key === 'R') {
        refreshNow();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, refreshNow, step, togglePaused]);

  const toggleFullscreen = useCallback(() => {
    const node = overlayRef.current;
    if (!node) return;
    if (currentFullscreenElement()) {
      exitFullscreen();
    } else {
      requestFullscreenOn(node);
    }
  }, []);

  if (!camera) return null;

  const label = camera.label ?? camera.name;

  return (
    <div
      className="viewer"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${label} camera`}
    >
      <div className="viewer__bar">
        <span className="viewer__title">{label}</span>
        {paused ? (
          <span className="pill">paused</span>
        ) : streamDown ? (
          <span className="pill">reconnecting</span>
        ) : (
          <span className="pill pill--live">live</span>
        )}

        <div className="viewer__actions">
          {cameras.length > 1 ? (
            <>
              <button type="button" className="viewer__btn" onClick={() => step(-1)} aria-label="Previous camera">
                ‹
              </button>
              <span className="viewer__count">
                {index + 1} / {cameras.length}
              </span>
              <button type="button" className="viewer__btn" onClick={() => step(1)} aria-label="Next camera">
                ›
              </button>
            </>
          ) : null}

          <button type="button" className="viewer__btn" onClick={togglePaused} aria-pressed={paused}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="viewer__btn" onClick={refreshNow}>
            Reconnect
          </button>
          {FULLSCREEN_SUPPORTED ? (
            <button type="button" className="viewer__btn" onClick={toggleFullscreen} aria-pressed={isFullscreen}>
              {isFullscreen ? 'Exit full screen' : 'Full screen'}
            </button>
          ) : null}
          <button type="button" className="viewer__btn viewer__btn--close" onClick={onClose} ref={closeRef}>
            Close
          </button>
        </div>
      </div>

      <figure
        className="viewer__frame"
        // The <img> is stretched over the whole frame with object-fit: contain,
        // so its letterbox bars are part of the element; whether a click landed
        // on the picture or beside it is geometry, not event targets. Beside it
        // closes, on it does not.
        onClick={(event) => {
          const img = event.currentTarget.querySelector('img');
          if (!img || !img.naturalWidth || !img.naturalHeight) return;
          const box = img.getBoundingClientRect();
          const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
          const width = img.naturalWidth * scale;
          const height = img.naturalHeight * scale;
          const left = box.left + (box.width - width) / 2;
          const top = box.top + (box.height - height) / 2;
          const onPicture =
            event.clientX >= left &&
            event.clientX <= left + width &&
            event.clientY >= top &&
            event.clientY <= top + height;
          if (!onPicture) onClose();
        }}
      >
        {streaming ? (
          <img
            key={`stream-${camera.name}-${streamKey}`}
            src={`/api/camera/${camera.name}/stream?h=1080&fps=5&k=${streamKey}`}
            alt={`Live view of ${label}`}
            onError={() => setStreamDown(true)}
          />
        ) : (
          <img src={`/api/camera/${camera.name}/snapshot?h=1080&t=${tick}`} alt={`Latest still from ${label}`} />
        )}
      </figure>

      <p className="viewer__hint">Esc to close · ← → to switch cameras · Space to pause · R to reconnect</p>
    </div>
  );
}
