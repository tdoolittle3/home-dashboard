import { useEffect, useState } from 'react';
import type { CameraRef } from '../types';
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

  useEffect(() => {
    const interval = setInterval(() => setTick(Date.now()), Math.max(refreshSeconds, 1) * 1000);
    return () => clearInterval(interval);
  }, [refreshSeconds]);

  return (
    <Panel title={title}>
      <div className="cameras">
        {cameras.map((camera) => (
          <figure key={camera.name} className="camera">
            <img
              // The cache-buster is what actually forces the refresh.
              src={`/api/camera/${camera.name}/snapshot?h=360&t=${tick}`}
              alt={`Latest still from ${camera.label ?? camera.name}`}
              loading="lazy"
            />
            <figcaption>{camera.label ?? camera.name}</figcaption>
          </figure>
        ))}
      </div>
    </Panel>
  );
}
