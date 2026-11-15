import type { EntitySnapshot, KumaSummary, SourceResult, SystemMetricRef, UpsEntityRefs } from '../types';
import { KumaHealth } from './UptimePanel';
import { Panel } from './Panel';
import { SystemPanel } from './SystemPanel';
import { UpsPanel } from './UpsPanel';

interface TvStatusPanelProps {
  /** The system panel's metrics, when the room includes one. */
  systemMetrics?: SystemMetricRef[];
  /** The ups panel's entity refs, when the room includes one. */
  upsRefs?: UpsEntityRefs;
  /** The Kuma source result; undefined = the room has no uptime panel at all. */
  kuma?: SourceResult<KumaSummary> | null;
  entities: Record<string, EntitySnapshot>;
}

/**
 * /tv's one status card: System, Power and Uptime Kuma squashed together so
 * the flight map can have their old space. The side column carries the Kuma
 * traffic light and the battery gauge (charge + time on battery - the stats
 * and voltage sparkline stay on the phone dashboard); the system tiles fill
 * the rest. Each piece renders only when its panel is in the room preset.
 */
export function TvStatusPanel({ systemMetrics, upsRefs, kuma, entities }: TvStatusPanelProps) {
  return (
    <Panel title="Status" className="tv-status-panel">
      <div className="tv-status">
        {kuma !== undefined || upsRefs ? (
          <div className="tv-status__side">
            {kuma !== undefined ? <KumaHealth result={kuma} /> : null}
            {upsRefs ? <UpsPanel bare compact title="Power" refs={upsRefs} entities={entities} /> : null}
          </div>
        ) : null}
        {systemMetrics ? (
          <div className="tv-status__system">
            <SystemPanel bare title="System" metrics={systemMetrics} entities={entities} />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
