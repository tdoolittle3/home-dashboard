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

type FrigateEventRow = FrigateSummary['recentEvents'][number];

/**
 * Where a detection row leads: the clip itself, or its snapshot while Frigate
 * has no clip yet. Both come from this dashboard's own origin - the server
 * proxies them, because a device that can reach the dashboard may have no
 * route to Frigate's port, and Frigate cannot answer the byte-range requests
 * iPhone Safari demands before it will play an MP4.
 */
function eventHref(event: FrigateEventRow): string | undefined {
  const id = encodeURIComponent(event.id);
  if (event.hasClip) return `/api/events/${id}/clip.mp4`;
  if (event.hasSnapshot) return `/api/events/${id}/snapshot.jpg`;
  return undefined;
}

/**
 * The hero row polls Frigate stills through the backend rather than embedding
 * live streams: a still every few seconds costs the detector nothing, while
 * Frigate encodes MJPEG per connected viewer. The live stream runs only in the
 * full-screen viewer, where someone has deliberately opened one camera.
 */
export function CamerasPanel({
  title,
  cameras,
  refreshSeconds,
  stillHeight = 360,
  frigate,
}: CamerasPanelProps) {
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
          <ul className="rows rows--tight rows--stamped">
            {frigate.data.recentEvents.slice(0, 5).map((event) => {
              const href = eventHref(event);
              const content = (
                <>
                  <span className="row__label">
                    {event.label} · {event.camera}
                    {event.count > 1 ? <span className="row__repeat"> ×{event.count}</span> : null}
                  </span>
                  <span className="row__value">
                    {event.score === null ? '' : `${Math.round(event.score * 100)}%`}
                  </span>
                  <span className="row__meta">{formatEventTime(event.startTime)}</span>
                </>
              );
              return href ? (
                <li key={event.id} className="row row--event">
                  <a className="row__link" href={href} target="_blank" rel="noreferrer">
                    {content}
                  </a>
                </li>
              ) : (
                <li key={event.id} className="row">
                  {content}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {viewingCamera ? <CameraViewer camera={viewingCamera} onClose={() => setViewing(null)} /> : null}
    </Panel>
  );
}
