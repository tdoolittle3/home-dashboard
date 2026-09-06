import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraRef } from '../types';

interface CameraViewerProps {
  cameras: CameraRef[];
  /** Index into `cameras` of the one being shown. */
  index: number;
  refreshSeconds: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}

/**
 * Full-screen still viewer. The panel thumbnails ask Frigate for a 360px-high
 * frame; here we ask for 1080 instead, which is the ceiling the proxy allows.
 *
 * This is an overlay first and a real Fullscreen API call second: the overlay
 * works everywhere and can be dismissed with Escape, while browser fullscreen
 * needs a user gesture and is refused in some embedded contexts.
 */
export function CameraViewer({ cameras, index, refreshSeconds, onSelect, onClose }: CameraViewerProps) {
  const camera = cameras[index];
  const [tick, setTick] = useState(() => Date.now());
  const [paused, setPaused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const refreshNow = useCallback(() => setTick(Date.now()), []);

  const step = useCallback(
    (delta: number) => {
      if (cameras.length < 2) return;
      // Wrap in both directions so the arrow keys never dead-end.
      onSelect((index + delta + cameras.length) % cameras.length);
      setTick(Date.now());
    },
    [cameras.length, index, onSelect],
  );

  // Poll for a fresh still unless the viewer is paused.
  useEffect(() => {
    if (paused) return;
    const interval = setInterval(() => setTick(Date.now()), Math.max(refreshSeconds, 1) * 1000);
    return () => clearInterval(interval);
  }, [paused, refreshSeconds]);

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
  useEffect(() => {
    const sync = () => setIsFullscreen(document.fullscreenElement === overlayRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // While in browser fullscreen the first Escape exits that; let the
        // browser handle it and keep the overlay open.
        if (document.fullscreenElement) return;
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
        setPaused((current) => !current);
      } else if (event.key === 'r' || event.key === 'R') {
        refreshNow();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, refreshNow, step]);

  const toggleFullscreen = useCallback(() => {
    const node = overlayRef.current;
    if (!node) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      // Refused in some embedded contexts; the overlay still stands on its own.
      void node.requestFullscreen().catch(() => undefined);
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
      // A click on the backdrop closes; clicks inside the frame must not.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="viewer__bar">
        <span className="viewer__title">{label}</span>
        {paused ? <span className="pill">paused</span> : <span className="pill pill--live">live</span>}

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

          <button
            type="button"
            className="viewer__btn"
            onClick={() => setPaused((current) => !current)}
            aria-pressed={paused}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="viewer__btn" onClick={refreshNow}>
            Refresh
          </button>
          <button type="button" className="viewer__btn" onClick={toggleFullscreen} aria-pressed={isFullscreen}>
            {isFullscreen ? 'Exit full screen' : 'Full screen'}
          </button>
          <button type="button" className="viewer__btn viewer__btn--close" onClick={onClose} ref={closeRef}>
            Close
          </button>
        </div>
      </div>

      <figure className="viewer__frame">
        <img src={`/api/camera/${camera.name}/snapshot?h=1080&t=${tick}`} alt={`Latest still from ${label}`} />
      </figure>

      <p className="viewer__hint">Esc to close · ← → to switch cameras · Space to pause · R to refresh</p>
    </div>
  );
}
