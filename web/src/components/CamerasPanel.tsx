import { useEffect, useState } from 'react';
import type { CameraRef } from '../types';
import { CameraViewer } from './CameraViewer';
import { Panel } from './Panel';

interface CamerasPanelProps {
  title: string;
  cameras: CameraRef[];
  refreshSeconds: number;
  /** Height to request from the proxy. The hero row renders large enough that
      the old 360px default looked soft on a wide screen. */
  stillHeight?: number;
}

/**
 * Polls Frigate stills through the backend rather than embedding a live stream.
 * A still every few seconds costs the detector nothing; MJPEG or WebRTC per open
 * tab does not. Swapping in go2rtc/WebRTC later only changes this component.
 */
export function CamerasPanel({ title, cameras, refreshSeconds, stillHeight = 360 }: CamerasPanelProps) {
  const [tick, setTick] = useState(() => Date.now());
  const [viewing, setViewing] = useState<number | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setTick(Date.now()), Math.max(refreshSeconds, 1) * 1000);
    return () => clearInterval(interval);
  }, [refreshSeconds]);

  return (
    <Panel title={title} aside={`refreshes every ${refreshSeconds}s`}>
      <div className="cameras">
        {cameras.map((camera, index) => (
          <figure key={camera.name} className="camera">
            {/* A button rather than a click handler on the image, so the frame is
                reachable by keyboard and announced as activatable. */}
            <button
              type="button"
              className="camera__open"
              onClick={() => setViewing(index)}
              aria-label={`Open ${camera.label ?? camera.name} full screen`}
            >
              <img
                // The cache-buster is what actually forces the refresh.
                src={`/api/camera/${camera.name}/snapshot?h=${stillHeight}&t=${tick}`}
                alt={`Latest still from ${camera.label ?? camera.name}`}
                loading="lazy"
              />
              <span className="camera__expand" aria-hidden="true">
                ⤢
              </span>
            </button>
            {/* The caption is laid over the still rather than set beneath it, so
                the name and the picture read as one object. It sits outside the
                button because a button may only contain phrasing content, and it
                ignores the pointer so clicks still reach the button. */}
            <figcaption className="camera__caption">
              <span className="camera__live" aria-hidden="true" />
              {camera.label ?? camera.name}
            </figcaption>
          </figure>
        ))}
      </div>

      {viewing !== null ? (
        <CameraViewer
          cameras={cameras}
          index={viewing}
          refreshSeconds={refreshSeconds}
          onSelect={setViewing}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </Panel>
  );
}
