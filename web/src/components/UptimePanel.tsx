import { formatNumber } from '../format';
import type { KumaMonitor, KumaSummary, SourceResult } from '../types';
import { ServicePanel } from './ServicePanel';

interface UptimePanelProps {
  title: string;
  result: SourceResult<KumaSummary> | null;
}

const STATUS_LABEL: Record<KumaMonitor['status'], string> = {
  up: 'up',
  down: 'down',
  pending: 'pending',
  maintenance: 'maintenance',
  unknown: 'unknown',
};

function summarize(data: KumaSummary): string {
  if (data.monitors.length === 0) return 'no monitors';
  const parts = [`${data.up} up`];
  if (data.down > 0) parts.push(`${data.down} down`);
  if (data.pending > 0) parts.push(`${data.pending} pending`);
  if (data.maintenance > 0) parts.push(`${data.maintenance} in maintenance`);
  return parts.join(' · ');
}

/** The right-hand cell: latency while up, otherwise the state in words. */
function valueFor(monitor: KumaMonitor): string {
  if (monitor.status === 'up' && monitor.responseTimeMs !== null) return `${formatNumber(monitor.responseTimeMs)} ms`;
  return STATUS_LABEL[monitor.status];
}

/** Kuma reports 0 cert days for anything that is not HTTPS, so only a positive count means a cert. */
function metaFor(monitor: KumaMonitor): string {
  if (monitor.certDaysRemaining !== null && monitor.certDaysRemaining > 0) {
    return `cert ${Math.round(monitor.certDaysRemaining)}d`;
  }
  return monitor.type ?? '';
}

export function UptimePanel({ title, result }: UptimePanelProps) {
  return (
    <ServicePanel
      title={title}
      result={result}
      envKeys={['UPTIME_KUMA_BASE_URL', 'UPTIME_KUMA_API_KEY']}
      aside={summarize}
    >
      {(data) =>
        data.monitors.length === 0 ? (
          <p className="empty">
            Uptime Kuma is reachable but has no monitors yet. Add them in Kuma and they appear here on the next
            refresh.
          </p>
        ) : (
          <ul className="rows">
            {data.monitors.map((monitor) => {
              const alert = monitor.status === 'down';
              const certLow = monitor.certDaysRemaining !== null && monitor.certDaysRemaining > 0 && monitor.certDaysRemaining < 14;
              return (
                <li key={monitor.name} className="row">
                  <span className="row__label row__label--dotted">
                    <span className={`dot dot--${monitor.status}`} aria-hidden="true" />
                    <span className="row__text">
                      <span className="row__title">{monitor.name}</span>
                      {monitor.target ? <span className="row__sub">{monitor.target}</span> : null}
                    </span>
                  </span>
                  <span className={alert ? 'row__value row__value--alert' : 'row__value'}>{valueFor(monitor)}</span>
                  <span className={certLow ? 'row__meta row__meta--alert' : 'row__meta'}>{metaFor(monitor)}</span>
                </li>
              );
            })}
          </ul>
        )
      }
    </ServicePanel>
  );
}
