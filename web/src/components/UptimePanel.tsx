import { formatNumber } from '../format';
import type { KumaMonitor, KumaSummary, SourceResult } from '../types';
import { Collapsible } from './Collapsible';
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

/**
 * The traffic light over the monitor list. One thing down is a degradation;
 * two or more is a disruption - at this fleet's size that is either a shared
 * cause or half the house. Pending only dims to yellow because Kuma reports
 * it while a monitor is still deciding, not once it has failed.
 */
function health(data: KumaSummary): { level: 'ok' | 'degraded' | 'outage' | 'unknown'; title: string; sub: string } {
  const total = data.monitors.length;
  if (total === 0) return { level: 'unknown', title: 'No monitors', sub: 'nothing being watched yet' };
  const down = data.monitors.filter((monitor) => monitor.status === 'down').map((monitor) => monitor.name);
  if (down.length >= 2) {
    return { level: 'outage', title: 'Service disruption', sub: `down: ${down.join(', ')}` };
  }
  if (down.length === 1) {
    return { level: 'degraded', title: 'Something is down', sub: `down: ${down[0]}` };
  }
  if (data.pending > 0) {
    return { level: 'degraded', title: 'Waiting on checks', sub: `${data.pending} pending · ${data.up} of ${total} up` };
  }
  return { level: 'ok', title: 'All systems up', sub: `${data.up} of ${total} monitors up` };
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
      {(data) => {
        if (data.monitors.length === 0) {
          return (
            <p className="empty">
              Uptime Kuma is reachable but has no monitors yet. Add them in Kuma and they appear here on the next
              refresh.
            </p>
          );
        }
        const state = health(data);
        return (
          <>
            <div className={`health health--${state.level}`}>
              <span className="health__title">{state.title}</span>
              <span className="health__sub">{state.sub}</span>
            </div>
            <Collapsible label={`all ${data.monitors.length} monitors`}>
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
            </Collapsible>
          </>
        );
      }}
    </ServicePanel>
  );
}
