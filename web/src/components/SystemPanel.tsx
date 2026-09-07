import { useEffect, useState } from 'react';
import { formatNumber, formatRelative, formatState, formatUptime, isProblem, labelFor } from '../format';
import type { EntitySnapshot, SystemMetricKind, SystemMetricRef } from '../types';
import { Panel } from './Panel';

interface SystemPanelProps {
  title: string;
  metrics: SystemMetricRef[];
  entities: Record<string, EntitySnapshot>;
}

/** `off` is an entity that is missing or unavailable, drawn dim rather than coloured. */
type Level = 'ok' | 'warn' | 'crit' | 'off';

/** Home Assistant has reported boot time under both device classes across versions. */
const CLOCK_CLASSES = new Set(['timestamp', 'uptime']);

/** How often the elapsed-time figures advance without any state change from HA. */
const TICK_MS = 30_000;

function kindOf(ref: SystemMetricRef, entity: EntitySnapshot | undefined): SystemMetricKind {
  if (ref.kind) return ref.kind;
  if (entity?.deviceClass && CLOCK_CLASSES.has(entity.deviceClass)) return 'uptime';
  if (entity?.unit === '%') return 'percent';
  return 'value';
}

function numeric(entity: EntitySnapshot | undefined): number | null {
  if (!entity || entity.missing) return null;
  const value = Number(entity.state);
  return entity.state.trim() !== '' && Number.isFinite(value) ? value : null;
}

/** Seconds since the instant the entity's state names, or null when it is not a time. */
function elapsedSeconds(entity: EntitySnapshot | undefined, now: number): number | null {
  if (!entity || entity.missing) return null;
  const then = Date.parse(entity.state);
  return Number.isFinite(then) ? Math.max(0, Math.round((now - then) / 1000)) : null;
}

function levelFor(ref: SystemMetricRef, entity: EntitySnapshot | undefined, value: number | null): Level {
  if (!entity || entity.missing || isProblem(entity)) return 'off';
  if (value === null) return 'ok';
  if (ref.crit !== undefined && value >= ref.crit) return 'crit';
  if (ref.warn !== undefined && value >= ref.warn) return 'warn';
  return 'ok';
}

function formatSince(entity: EntitySnapshot | undefined): string {
  if (!entity || entity.missing) return formatState(entity);
  const then = new Date(entity.state);
  if (!Number.isFinite(then.getTime())) return entity.state;
  return `since ${then.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * Host uptime as the headline, then one tile per hardware reading. Percentages
 * get a bar so five gauges can be compared at a glance from across a room;
 * everything else is the figure and its unit. Thresholds come from the config
 * rather than being guessed here, because what counts as hot or full depends on
 * the box.
 */
export function SystemPanel({ title, metrics, entities }: SystemPanelProps) {
  // Uptime is derived from a fixed instant, so it has to advance on its own.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const uptimes = metrics.filter((ref) => kindOf(ref, entities[ref.entity_id]) === 'uptime');
  const readings = metrics.filter((ref) => kindOf(ref, entities[ref.entity_id]) !== 'uptime');

  const freshest = metrics
    .map((ref) => entities[ref.entity_id]?.lastChanged ?? null)
    .filter((iso): iso is string => iso !== null)
    .sort()
    .at(-1);

  return (
    <Panel title={title} aside={freshest ? `updated ${formatRelative(freshest)}` : null}>
      <div className="system">
        {uptimes.map((ref) => {
          const entity = entities[ref.entity_id];
          const seconds = elapsedSeconds(entity, now);
          const level = levelFor(ref, entity, null);
          return (
            <div key={ref.entity_id} className={`system__hero system__hero--${level}`}>
              <span className="system__hero-label">{labelFor(ref, entity)}</span>
              <span className="system__hero-value">{seconds === null ? formatState(entity) : formatUptime(seconds)}</span>
              <span className="system__hero-note">{seconds === null ? '' : formatSince(entity)}</span>
            </div>
          );
        })}

        {readings.length > 0 ? (
          <ul className="stats">
            {readings.map((ref) => {
              const entity = entities[ref.entity_id];
              const kind = kindOf(ref, entity);
              const value = numeric(entity);
              const level = levelFor(ref, entity, value);
              const unit = value === null ? null : entity?.unit ?? null;
              return (
                <li key={ref.entity_id} className={`stat stat--${level}`}>
                  <span className="stat__label">{labelFor(ref, entity)}</span>
                  <span className="stat__value">
                    {value === null ? formatState(entity) : formatNumber(value)}
                    {unit ? <span className="stat__unit">{unit}</span> : null}
                  </span>
                  {kind === 'percent' ? (
                    <span className="stat__bar" aria-hidden="true">
                      <span
                        className="stat__fill"
                        style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }}
                      />
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}
