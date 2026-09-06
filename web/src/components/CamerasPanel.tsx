import { useEffect, useState } from 'react';
import type { CameraRef } from '../types';
import { CameraViewer } from './CameraViewer';
import { Panel } from './Panel';

interface CamerasPanelProps {
  title: string;
  cameras: CameraRef[];
  refreshSeconds: number;
}

/**
 * Polls Frigate stills through the backend rather than embedding a live stream.
 * A still every few seconds costs the detector nothing; MJPEG or WebRTC per open
 * tab does not. Swapping in go2rtc/WebRTC later only changes this component.
 */
export function CamerasPanel({ title, cameras, refreshSeconds }: CamerasPanelProps) {
  const [tick, setTick] = useState(() => Date.now());
  const [viewing, setViewing] = useState<number | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setTick(Date.now()), Math.max(refreshSeconds, 1) * 1000);
    return () => clearInterval(interval);
  }, [refreshSeconds]);

  return (
    <Panel title={title}>
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
                src={`/api/camera/${camera.name}/snapshot?h=360&t=${tick}`}
                alt={`Latest still from ${camera.label ?? camera.name}`}
                loading="lazy"
              />
              <span className="camera__expand" aria-hidden="true">
                ⤢
              </span>
            </button>
            <figcaption>{camera.label ?? camera.name}</figcaption>
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
