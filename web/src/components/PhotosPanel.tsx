import { formatBytes, formatNumber } from '../format';
import type { ImmichSummary, SourceResult } from '../types';
import { ServicePanel } from './ServicePanel';

interface PhotosPanelProps {
  title: string;
  result: SourceResult<ImmichSummary> | null;
}

function aside(data: ImmichSummary): string {
  return data.version ?? '';
}

/** Immich's disk figure is the filesystem behind the upload location, seen from its container. */
function diskPercent(disk: NonNullable<ImmichSummary['disk']>): number | null {
  if (disk.usagePercent !== null) return Math.max(0, Math.min(100, disk.usagePercent));
  if (disk.usedBytes !== null && disk.sizeBytes !== null && disk.sizeBytes > 0) {
    return Math.max(0, Math.min(100, (disk.usedBytes / disk.sizeBytes) * 100));
  }
  return null;
}

export function PhotosPanel({ title, result }: PhotosPanelProps) {
  return (
    <ServicePanel title={title} result={result} envKeys={['IMMICH_BASE_URL', 'IMMICH_API_KEY']} aside={aside}>
      {(data) => {
        const { library, disk, jobs } = data;
        const percent = disk ? diskPercent(disk) : null;
        const busyQueues = jobs ? jobs.queues.filter((queue) => queue.active + queue.waiting + queue.failed > 0) : [];

        return (
          <>
            {library ? (
              <div className="stats">
                <div className="stat">
                  <div className="stat__value">{formatNumber(library.photos)}</div>
                  <div className="stat__label">Photos</div>
                </div>
                <div className="stat">
                  <div className="stat__value">{formatNumber(library.videos)}</div>
                  <div className="stat__label">Videos</div>
                </div>
                <div className="stat">
                  <div className="stat__value">{formatBytes(library.usageBytes)}</div>
                  <div className="stat__label">Library</div>
                </div>
              </div>
            ) : (
              <p className="empty">
                Connected. Library totals and the job queue are admin-only in Immich, so IMMICH_API_KEY needs to
                come from the admin account to fill this panel in.
              </p>
            )}

            {disk && percent !== null ? (
              <>
                <h3 className="subhead">Photo disk</h3>
                <div className="meter meter--tall" role="img" aria-label={`${Math.round(percent)}% used`}>
                  <span
                    className={percent >= 90 ? 'meter__fill meter__fill--alert' : 'meter__fill'}
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="meter-caption">
                  <span>
                    {formatBytes(disk.usedBytes)} of {formatBytes(disk.sizeBytes)} used
                  </span>
                  <span>{formatBytes(disk.availableBytes)} free</span>
                </div>
              </>
            ) : null}

            {library && library.users.length > 0 ? (
              <>
                <h3 className="subhead">By user</h3>
                <ul className="rows rows--tight">
                  {library.users.map((user) => (
                    <li key={user.name} className="row">
                      <span className="row__label">{user.name}</span>
                      <span className="row__value">{formatBytes(user.usageBytes)}</span>
                      <span className="row__meta">
                        {formatNumber(user.photos)} photos · {formatNumber(user.videos)} videos
                        {user.quotaBytes !== null && user.quotaBytes > 0 ? ` · quota ${formatBytes(user.quotaBytes)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {jobs ? (
              <>
                <h3 className="subhead">Jobs</h3>
                {busyQueues.length === 0 ? (
                  <p className="empty">All queues idle.</p>
                ) : (
                  <ul className="rows rows--tight">
                    {busyQueues.map((queue) => {
                      const state = queue.paused ? 'maintenance' : queue.active > 0 ? 'up' : queue.failed > 0 ? 'down' : 'pending';
                      return (
                        <li key={queue.name} className="row">
                          <span className="row__label row__label--dotted">
                            <span className={`dot dot--${state}`} aria-hidden="true" />
                            <span className="row__title">{queue.name}</span>
                          </span>
                          <span className="row__value row__value--quiet">
                            {queue.active > 0
                              ? `${formatNumber(queue.active)} active`
                              : queue.paused
                                ? 'paused'
                                : queue.waiting > 0
                                  ? 'queued'
                                  : 'idle'}
                          </span>
                          <span className={queue.failed > 0 ? 'row__meta row__meta--alert' : 'row__meta'}>
                            {[
                              queue.waiting > 0 ? `${formatNumber(queue.waiting)} waiting` : null,
                              queue.failed > 0 ? `${formatNumber(queue.failed)} failed` : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            ) : null}
          </>
        );
      }}
    </ServicePanel>
  );
}
