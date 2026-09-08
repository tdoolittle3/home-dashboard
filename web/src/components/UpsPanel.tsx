import { useEffect, useState } from 'react';
import { fetchHistory } from '../api';
import { formatNumber, formatRelative } from '../format';
import type { EntitySnapshot, HistoryPoint, UpsEntityRefs } from '../types';
import { Panel } from './Panel';

interface UpsPanelProps {
  title: string;
  refs: UpsEntityRefs;
  entities: Record<string, EntitySnapshot>;
}

/**
 * `off` means the readings cannot be trusted: the problem sensor is not in HA
 * (restart lag, MQTT down) or reports unavailable. It is deliberately distinct
 * from `critical`, which is the guard actively saying the power is bad - the
 * guard covers "UPS unreachable" itself, so `off` is only ever a data gap.
 */
type Mode = 'ok' | 'warning' | 'critical' | 'off';

/** How often the on-battery countdown advances between the guard's minutely publishes. */
const TICK_MS = 15_000;
const HISTORY_HOURS = 24;
const HISTORY_REFRESH_MS = 5 * 60_000;
const NOMINAL_VOLTS = 120;

/** States that mean HA has the entity but no usable reading. */
const DEAD_STATES = new Set(['unavailable', 'unknown', 'error']);

// --- gauge geometry: a 270° arc, open at the bottom like a speedometer ---

const SIZE = 180;
const STROKE = 13;
const RADIUS = (SIZE - STROKE) / 2 - 2;
const CENTER = SIZE / 2;
const START_DEG = 225; // 7:30 on a clock face
const SWEEP_DEG = 270;

/** Point on the gauge at `fraction` of full charge, clockwise from the start. */
function gaugePoint(fraction: number): [number, number] {
  const rad = ((START_DEG + SWEEP_DEG * fraction) * Math.PI) / 180;
  return [CENTER + RADIUS * Math.sin(rad), CENTER - RADIUS * Math.cos(rad)];
}

function arcPath(from: number, to: number): string {
  const [x0, y0] = gaugePoint(from);
  const [x1, y1] = gaugePoint(to);
  const largeArc = (to - from) * SWEEP_DEG > 180 ? 1 : 0;
  return `M ${x0.toFixed(3)} ${y0.toFixed(3)} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${x1.toFixed(3)} ${y1.toFixed(3)}`;
}

function numeric(entity: EntitySnapshot | undefined): number | null {
  if (!entity || entity.missing || DEAD_STATES.has(entity.state.toLowerCase())) return null;
  const value = Number(entity.state);
  return entity.state.trim() !== '' && Number.isFinite(value) ? value : null;
}

function attrString(entity: EntitySnapshot | undefined, key: string): string | null {
  const value = entity?.attributes[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** "2h 07m" / "38m" - the shape a runtime is judged in during an outage. */
function formatRuntime(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

/** The headline for the critical banner, from the raw NUT status tokens. */
function criticalTitle(upsStatus: string | null): string {
  const tokens = new Set((upsStatus ?? '').split(/\s+/));
  if (tokens.has('LB')) return 'LOW BATTERY';
  if (tokens.has('OB')) return 'ON BATTERY';
  if (!upsStatus) return 'UPS UNREACHABLE';
  return 'POWER PROBLEM';
}

/**
 * 24 hours of input voltage, so brownouts and past outages stay visible after
 * the fact. History is recorded data, not a live reading, so it renders in
 * every mode - including `off`, where the dip to the data gap is the story.
 */
function VoltageSparkline({ points }: { points: HistoryPoint[] }) {
  const W = 260;
  const H = 40;
  const PAD = 3;

  const values = points.map((p) => p.v);
  let min = Math.min(...values);
  let max = Math.max(...values);
  // A healthy feed is a flat line; give it a band so noise does not fill the box.
  if (max - min < 4) {
    const mid = (max + min) / 2;
    min = mid - 2;
    max = mid + 2;
  }

  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => PAD + ((t - t0) / span) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.t).toFixed(2)} ${y(p.v).toFixed(2)}`).join(' ');

  return (
    <div className="ups__spark">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Input voltage over the last ${HISTORY_HOURS} hours, ${formatNumber(min)} to ${formatNumber(max)} volts`}
      >
        {min <= NOMINAL_VOLTS && NOMINAL_VOLTS <= max ? (
          <line
            className="ups__spark-nominal"
            x1={PAD}
            x2={W - PAD}
            y1={y(NOMINAL_VOLTS)}
            y2={y(NOMINAL_VOLTS)}
          />
        ) : null}
        <path className="ups__spark-line" d={path} />
      </svg>
      <div className="ups__spark-caption">
        <span>input voltage · {HISTORY_HOURS}h</span>
        <span>
          {formatNumber(Math.min(...values))}–{formatNumber(Math.max(...values))} V
        </span>
      </div>
    </div>
  );
}

/**
 * The rack UPS. Idle it is a calm battery gauge; on battery the estimated
 * runtime takes over as the headline, because during an outage that number is
 * what everything else - a graceful shutdown, a run to the breaker panel - is
 * judged against. The guard's own verdict (the problem sensor's status
 * attribute) drives the look, so the panel and the ntfy alerts never disagree.
 */
export function UpsPanel({ title, refs, entities }: UpsPanelProps) {
  const problem = entities[refs.problem];
  const chargeEntity = entities[refs.charge];
  const runtimeEntity = entities[refs.runtime];

  const charge = numeric(chargeEntity);
  const runtimeMin = numeric(runtimeEntity);
  const load = numeric(entities[refs.load]);
  const voltage = numeric(entities[refs.voltage]);

  const dataLive = !!problem && !problem.missing && !DEAD_STATES.has(problem.state.toLowerCase());
  const statusAttr = attrString(problem, 'status');
  const reason = attrString(problem, 'reason');
  const upsStatus = attrString(problem, 'ups_status');

  // The guard's verdict when it is talking; the bare on/off as the fallback.
  const mode: Mode = !dataLive
    ? 'off'
    : statusAttr === 'critical' || statusAttr === 'warning' || statusAttr === 'ok'
      ? statusAttr
      : problem.state.toLowerCase() === 'on'
        ? 'warning'
        : 'ok';

  // The countdown has to move on its own: the guard only publishes once a
  // minute, and a frozen number in a blackout reads as a crashed dashboard.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  let runtimeSec = runtimeMin === null ? null : runtimeMin * 60;
  if (mode === 'critical' && runtimeSec !== null && runtimeEntity?.lastChanged) {
    const elapsed = (now - Date.parse(runtimeEntity.lastChanged)) / 1000;
    if (Number.isFinite(elapsed) && elapsed > 0) runtimeSec = Math.max(0, runtimeSec - elapsed);
  }

  const [history, setHistory] = useState<HistoryPoint[]>([]);
  useEffect(() => {
    let alive = true;
    const pull = () => {
      fetchHistory(refs.voltage, HISTORY_HOURS)
        .then((points) => {
          if (alive) setHistory(points);
        })
        .catch(() => {
          /* the sparkline is a bonus; a recorder hiccup should not mark the panel */
        });
    };
    pull();
    const timer = setInterval(pull, HISTORY_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refs.voltage]);

  const freshest = [refs.charge, refs.runtime, refs.load, refs.voltage, refs.problem]
    .map((id) => entities[id]?.lastChanged ?? null)
    .filter((iso): iso is string => iso !== null)
    .sort()
    .at(-1);

  const chargeFraction = charge === null ? 0 : Math.min(1, Math.max(0, charge / 100));

  return (
    <Panel title={title} aside={freshest ? `updated ${formatRelative(freshest)}` : null}>
      <div className={`ups ups--${mode}`}>
        {mode === 'critical' ? (
          <div className="ups__banner ups__banner--critical" role="alert">
            <span className="ups__banner-title">⚡ {criticalTitle(upsStatus)}</span>
            {reason ? <span className="ups__banner-reason">{reason}</span> : null}
          </div>
        ) : null}
        {mode === 'warning' ? (
          <div className="ups__banner ups__banner--warning">
            <span className="ups__banner-title">Attention</span>
            {reason ? <span className="ups__banner-reason">{reason}</span> : null}
          </div>
        ) : null}
        {mode === 'off' ? (
          <div className="ups__banner ups__banner--off">
            <span className="ups__banner-title">UPS data unavailable</span>
            <span className="ups__banner-reason">
              {!problem || problem.missing ? 'entities not in HA - MQTT discovery pending?' : 'sensor unavailable'}
              {freshest ? ` · last data ${formatRelative(freshest)}` : ''}
            </span>
          </div>
        ) : null}

        <div className="ups__gauge">
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={charge === null ? 'Battery charge unknown' : `Battery ${charge}%`}>
            <path className="ups__gauge-track" d={arcPath(0, 1)} strokeWidth={STROKE} />
            {mode !== 'off' && chargeFraction > 0 ? (
              <path className="ups__gauge-fill" d={arcPath(0, chargeFraction)} strokeWidth={STROKE} />
            ) : null}
          </svg>
          <div className="ups__gauge-text">
            {mode === 'off' ? (
              <>
                <div className="ups__hero ups__hero--dim">—</div>
                <div className="ups__hero-sub">no data</div>
              </>
            ) : mode === 'critical' ? (
              <>
                <div className="ups__hero">{runtimeSec === null ? '—' : `~${formatRuntime(runtimeSec)}`}</div>
                <div className="ups__hero-sub">
                  left on battery
                  {charge === null ? '' : ` · ${formatNumber(charge)}%`}
                </div>
              </>
            ) : (
              <>
                <div className="ups__hero">
                  {charge === null ? '—' : formatNumber(charge)}
                  {charge === null ? null : <span className="ups__hero-unit">%</span>}
                </div>
                <div className="ups__hero-sub">
                  {runtimeSec === null ? 'runtime unknown' : `~${formatRuntime(runtimeSec)} on battery`}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="ups__stats">
          <div className="ups__stat">
            <span className="ups__stat-value">{load === null || mode === 'off' ? '—' : `${formatNumber(load)}%`}</span>
            <span className="ups__stat-label">load</span>
          </div>
          <div className="ups__stat">
            <span className="ups__stat-value">
              {voltage === null || mode === 'off' ? '—' : `${formatNumber(voltage)} V`}
            </span>
            <span className="ups__stat-label">input</span>
          </div>
        </div>

        {history.length >= 2 ? <VoltageSparkline points={history} /> : null}
      </div>
    </Panel>
  );
}
