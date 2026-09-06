import { formatNumber, formatRelative } from '../format';
import type { JellyfinRecentItem, JellyfinSummary, SourceResult } from '../types';
import { ServicePanel } from './ServicePanel';

interface MediaPanelProps {
  title: string;
  result: SourceResult<JellyfinSummary> | null;
}

/** Jellyfin's /Items/Counts keys, in the order worth showing. Zero counts are skipped. */
const COUNT_LABELS: [key: string, label: string][] = [
  ['MovieCount', 'Movies'],
  ['SeriesCount', 'Series'],
  ['EpisodeCount', 'Episodes'],
  ['AlbumCount', 'Albums'],
  ['SongCount', 'Songs'],
  ['BookCount', 'Books'],
];

function aside(data: JellyfinSummary): string {
  return [data.serverName, data.version].filter(Boolean).join(' · ');
}

function describe(item: JellyfinRecentItem): string {
  if (item.series && item.type === 'Episode') return `${item.series} - ${item.name}`;
  return item.year ? `${item.name} (${item.year})` : item.name;
}

export function MediaPanel({ title, result }: MediaPanelProps) {
  return (
    <ServicePanel title={title} result={result} envKeys={['JELLYFIN_BASE_URL', 'JELLYFIN_API_KEY']} aside={aside}>
      {(data) => {
        const counts = data.counts
          ? COUNT_LABELS.filter(([key]) => (data.counts?.[key] ?? 0) > 0).map(([key, label]) => ({
              label,
              value: data.counts?.[key] ?? 0,
            }))
          : [];
        const playing = data.sessions.filter((session) => session.nowPlaying !== null);
        const idleClients = data.sessions.length - playing.length;

        return (
          <>
            {counts.length > 0 ? (
              <div className="stats">
                {counts.map((count) => (
                  <div key={count.label} className="stat">
                    <div className="stat__value">{formatNumber(count.value)}</div>
                    <div className="stat__label">{count.label}</div>
                  </div>
                ))}
              </div>
            ) : null}

            <h3 className="subhead">Now playing</h3>
            {playing.length === 0 ? (
              <p className="empty">
                {idleClients > 0
                  ? `Nothing playing. ${idleClients} client${idleClients === 1 ? '' : 's'} connected.`
                  : 'Nothing playing.'}
              </p>
            ) : (
              <ul className="rows">
                {playing.map((session, index) => (
                  <li key={`${session.user ?? 'user'}-${session.device ?? index}`} className="row">
                    <span className="row__label">
                      <span className="row__text">
                        <span className="row__title">{session.nowPlaying}</span>
                        <span className="row__sub">
                          {[session.client, session.device].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </span>
                    <span className="row__value">{session.user ?? ''}</span>
                    <span className="row__meta">
                      {session.paused
                        ? 'paused'
                        : session.progressPercent !== null
                          ? `${session.progressPercent}%`
                          : 'playing'}
                    </span>
                    {session.progressPercent !== null ? (
                      <span className="row__bar">
                        <span className="meter">
                          <span
                            className={session.paused ? 'meter__fill meter__fill--idle' : 'meter__fill meter__fill--accent'}
                            style={{ width: `${session.progressPercent}%` }}
                          />
                        </span>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {data.recentlyAdded.length > 0 ? (
              <>
                <h3 className="subhead">Recently added</h3>
                <ul className="rows rows--tight">
                  {data.recentlyAdded.map((item) => (
                    <li key={item.id} className="row">
                      <span className="row__label">{describe(item)}</span>
                      <span className="row__value row__value--quiet">{item.type ?? ''}</span>
                      <span className="row__meta">{formatRelative(item.addedAt)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        );
      }}
    </ServicePanel>
  );
}
