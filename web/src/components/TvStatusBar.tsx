import { useEffect, useState, type ReactElement } from 'react';
import { formatNumber, formatState, formatUptime, labelFor } from '../format';
import type { EntitySnapshot, KumaSummary, SourceResult, SystemMetricRef, UpsEntityRefs } from '../types';
import { elapsedSeconds, kindOf, levelFor, numeric, type Level } from './SystemPanel';
import { health } from './UptimePanel';
import { criticalTitle, upsMode, upsNumeric } from './UpsPanel';

interface TvStatusBarProps {
  /** The system panel's metrics, when the room includes one. */
  systemMetrics?: SystemMetricRef[];
  /** The ups panel's entity refs, when the room includes one. */
  upsRefs?: UpsEntityRefs;
  /** The Kuma source result; undefined = the room has no uptime panel at all. */
  kuma?: SourceResult<KumaSummary> | null;
  entities: Record<string, EntitySnapshot>;
}

/** Chip tones share the system tiles' vocabulary so a hot reading looks the same everywhere. */
type Tone = Level;

const TICK_MS = 30_000;

function Chip({ tone, label, value }: { tone: Tone; label?: string; value: string }) {
  return (
    <span className={`tv-chip tv-chip--${tone}`}>
      <span className="tv-chip__dot" aria-hidden="true" />
      {label ? <span className="tv-chip__label">{label}</span> : null}
      <span className="tv-chip__value">{value}</span>
    </span>
  );
}

/**
 * /tv's house health as one line of chips in the top bar, so the screen below
 * can go to photos. Ambient by design: uptime and the percent gauges (CPU,
 * memory, ...) always show; every other system reading (temperatures, load,
 * network) stays hidden until it crosses its warn threshold, then appears in
 * its warning colour. The UPS chip is the charge while on mains and the
 * guard's headline plus runtime when it is not; Kuma is the traffic light.
 */
export function TvStatusBar({ systemMetrics = [], upsRefs, kuma, entities }: TvStatusBarProps) {
  // Uptime is derived from a fixed instant, so it has to advance on its own.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const chips: ReactElement[] = [];

  if (kuma !== undefined) {
    if (kuma?.ok) {
      const state = health(kuma.data);
      const tone: Tone = state.level === 'ok' ? 'ok' : state.level === 'outage' ? 'crit' : state.level === 'degraded' ? 'warn' : 'off';
      // Healthy = the short count; anything else = the names that are down.
      chips.push(<Chip key="kuma" tone={tone} value={state.level === 'ok' ? state.sub : state.sub || state.title} />);
    } else {
      chips.push(<Chip key="kuma" tone="off" value="uptime n/a" />);
    }
  }

  for (const ref of systemMetrics) {
    const entity = entities[ref.entity_id];
    const kind = kindOf(ref, entity);
    if (kind === 'uptime') {
      const seconds = elapsedSeconds(entity, now);
      chips.push(
        <Chip
          key={ref.entity_id}
          tone={levelFor(ref, entity, null)}
          label="up"
          value={seconds === null ? formatState(entity) : formatUptime(seconds)}
        />,
      );
      continue;
    }
    const value = numeric(entity);
    const level = levelFor(ref, entity, value);
    if (kind !== 'percent' && level !== 'warn' && level !== 'crit') continue;
    const unit = value === null ? '' : entity?.unit ?? '';
    chips.push(
      <Chip
        key={ref.entity_id}
        tone={level}
        label={labelFor(ref, entity)}
        value={value === null ? formatState(entity) : `${formatNumber(value)}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`}
      />,
    );
  }

  if (upsRefs) {
    const problem = entities[upsRefs.problem];
    const mode = upsMode(problem);
    const charge = upsNumeric(entities[upsRefs.charge]);
    const runtimeMin = upsNumeric(entities[upsRefs.runtime]);
    if (mode === 'ok') {
      chips.push(<Chip key="ups" tone="ok" label="UPS" value={charge === null ? '—' : `${formatNumber(charge)}%`} />);
    } else if (mode === 'off') {
      chips.push(<Chip key="ups" tone="off" label="UPS" value="no data" />);
    } else {
      const status = problem?.attributes['ups_status'];
      const title = criticalTitle(typeof status === 'string' && status.length > 0 ? status : null);
      const runtime = runtimeMin === null ? '' : ` · ${formatNumber(runtimeMin)} min`;
      chips.push(<Chip key="ups" tone={mode === 'critical' ? 'crit' : 'warn'} value={`${title}${runtime}`} />);
    }
  }

  if (chips.length === 0) return null;
  return <div className="tv-statusbar">{chips}</div>;
}
