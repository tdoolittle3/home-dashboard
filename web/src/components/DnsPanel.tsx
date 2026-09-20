import { formatNumber, formatRelative } from '../format';
import type { AdguardSummary, AdguardTopEntry, KumaStatus, KumaSummary, SourceResult } from '../types';
import { ServicePanel } from './ServicePanel';

interface DnsPanelProps {
  title: string;
  result: SourceResult<AdguardSummary> | null;
  /** The Kuma poll the Uptime panel already uses, reread here for the two DNS watchdogs. */
  kuma: SourceResult<KumaSummary> | null;
}

/** The Kuma monitors watching this resolver from outside, by their exact names in Kuma. */
const WATCHDOGS = ['DNS resolver', 'AdGuard UI'] as const;

function watchdogStatus(kuma: SourceResult<KumaSummary> | null, name: string): KumaStatus {
  if (!kuma?.ok) return 'unknown';
  return kuma.data.monitors.find((monitor) => monitor.name === name)?.status ?? 'unknown';
}

/** Top-N domains or clients as label + count over a relative bar. */
function TopList({ heading, entries }: { heading: string; entries: AdguardTopEntry[] }) {
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map((entry) => entry.count));
  return (
    <>
      <h3 className="subhead">{heading}</h3>
      <ul className="rows rows--tight">
        {entries.map((entry) => (
          <li key={entry.name} className="row">
            <span className="row__label">{entry.name}</span>
            <span className="row__value row__value--quiet">{formatNumber(entry.count)}</span>
            <span className="row__bar meter">
              <span className="meter__fill meter__fill--accent" style={{ width: `${(entry.count / max) * 100}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function DnsPanel({ title, result, kuma }: DnsPanelProps) {
  return (
    <ServicePanel
      title={title}
      result={result}
      envKeys={['ADGUARD_BASE_URL', 'ADGUARD_USERNAME', 'ADGUARD_PASSWORD']}
      aside={(data) => (
        <span className="checks">
          {WATCHDOGS.map((name) => (
            <span key={name} className="checks__item" title={`Uptime Kuma monitor "${name}"`}>
              <span className={`dot dot--${watchdogStatus(kuma, name)}`} aria-hidden="true" />
              {name}
            </span>
          ))}
          <span className="checks__item">
            <span className={`dot dot--${data.protectionEnabled ? 'up' : 'down'}`} aria-hidden="true" />
            protection {data.protectionEnabled ? 'on' : 'off'}
          </span>
          {data.version ? <span className="checks__item">{data.version}</span> : null}
        </span>
      )}
    >
      {(data) => (
        <>
          {data.stale ? (
            <p className="empty text-alert">
              AdGuard stopped answering - showing its last data and retrying gently.
              {data.lastError ? ` (${data.lastError})` : ''}
            </p>
          ) : null}

          <div className="stats">
            <div className="stat">
              <div className="stat__value">{formatNumber(data.queries)}</div>
              <div className="stat__label">Queries today</div>
            </div>
            <div className="stat">
              <div className="stat__value">
                {data.blockedPercent === null ? '—' : `${formatNumber(data.blockedPercent)}%`}
              </div>
              <div className="stat__label">Blocked</div>
            </div>
            <div className="stat">
              <div className="stat__value">
                {data.avgProcessingMs === null ? '—' : `${formatNumber(data.avgProcessingMs)} ms`}
              </div>
              <div className="stat__label">Avg lookup</div>
            </div>
          </div>

          {data.queries === 0 ? (
            <p className="empty">
              No queries yet - expected until the router points the house at this resolver. The panel fills in
              on its own after the cutover.
            </p>
          ) : null}

          <TopList heading="Top blocked" entries={data.topBlocked} />
          <TopList heading="Top clients" entries={data.topClients} />

          {data.recentQueries.length > 0 ? (
            <>
              <h3 className="subhead">Recent queries</h3>
              <ul className="rows rows--tight">
                {data.recentQueries.map((query, index) => (
                  <li key={`${query.time ?? ''}-${query.domain}-${index}`} className="row">
                    <span className="row__label row__label--dotted">
                      <span className={`dot dot--${query.blocked ? 'down' : 'up'}`} aria-hidden="true" />
                      <span className="row__text">
                        <span className="row__title">{query.domain}</span>
                        {query.client ? <span className="row__sub">{query.client}</span> : null}
                      </span>
                    </span>
                    <span
                      className={query.blocked ? 'row__value row__value--alert' : 'row__value row__value--quiet'}
                      {...(query.blocked && query.reason ? { title: query.reason } : {})}
                    >
                      {query.blocked ? 'blocked' : 'ok'}
                    </span>
                    <span className="row__meta">{formatRelative(query.time)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </ServicePanel>
  );
}
