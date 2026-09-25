import { useEffect, useState } from 'react';
import { formatEventTime } from '../format';
import type { CameraRef, FrigateSummary, SourceResult } from '../types';
import { CameraViewer } from './CameraViewer';
import { Panel } from './Panel';

interface CamerasPanelProps {
  title: string;
  cameras: CameraRef[];
  refreshSeconds: number;
  /** Height to request from the proxy. The hero row renders large enough that
      the old 360px default looked soft on a wide screen. */
  stillHeight?: number;
  /** Recent detections render under the stills they came from, not in Services. */
  frigate?: SourceResult<FrigateSummary> | null;
}

/**
 * The hero row polls Frigate stills through the backend rather than embedding
 * live streams: a still every few seconds costs the detector nothing, while
 * Frigate encodes MJPEG per connected viewer. The live stream runs only in the
 * full-screen viewer, where someone has deliberately opened one camera.
 */
export function CamerasPanel({ title, cameras, refreshSeconds, stillHeight = 360, frigate }: CamerasPanelProps) {
  const [tick, setTick] = useState(() => Date.now());
  const [viewing, setViewing] = useState<number | null>(null);
  const viewingCamera = viewing === null ? undefined : cameras[viewing];

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

      {frigate?.ok && frigate.data.recentEvents.length > 0 ? (
        <>
          <h3 className="subhead">Recent detections</h3>
          <ul className="rows rows--tight">
            {frigate.data.recentEvents.slice(0, 5).map((event) => (
              <li key={event.id} className="row">
                <span className="row__label">
                  {event.label} · {event.camera}
                </span>
                <span className="row__value">
                  {event.score === null ? '' : `${Math.round(event.score * 100)}%`}
                </span>
                <span className="row__meta">{formatEventTime(event.startTime)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {viewingCamera ? <CameraViewer camera={viewingCamera} onClose={() => setViewing(null)} /> : null}
    </Panel>
  );
}
