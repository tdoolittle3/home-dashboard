import { getJson } from './http.js';

export interface FrigateCameraStat {
  name: string;
  cameraFps: number | null;
  detectionFps: number | null;
  processFps: number | null;
  skippedFps: number | null;
}

export interface FrigateDetectorStat {
  name: string;
  inferenceSpeedMs: number | null;
}

export interface FrigateStorage {
  mount: string;
  totalMb: number | null;
  usedMb: number | null;
  freeMb: number | null;
}

export interface FrigateEvent {
  id: string;
  camera: string;
  label: string;
  startTime: number | null;
  endTime: number | null;
  score: number | null;
  hasSnapshot: boolean;
  hasClip: boolean;
  /** Frigate zones the object was in. Tells "car in the driveway" from "car on the road". */
  zones: string[];
  /** How many near-identical detections this row stands for (1 when nothing was folded in). */
  count: number;
}

export interface FrigateSummary {
  version: string | null;
  uptimeSeconds: number | null;
  cameras: FrigateCameraStat[];
  detectors: FrigateDetectorStat[];
  storage: FrigateStorage[];
  recentEvents: FrigateEvent[];
}

/**
 * Frigate reshuffles its /api/stats payload between minor versions (0.14 through
 * 0.17 all differ), so every field is read defensively and reported as null when
 * missing rather than crashing the panel.
 */
interface RawStats {
  cameras?: Record<string, Record<string, unknown>>;
  detectors?: Record<string, Record<string, unknown>>;
  service?: {
    version?: unknown;
    uptime?: unknown;
    storage?: Record<string, Record<string, unknown>>;
  };
}

interface RawEvent {
  id?: unknown;
  camera?: unknown;
  label?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  top_score?: unknown;
  has_snapshot?: unknown;
  has_clip?: unknown;
  zones?: unknown;
  data?: { top_score?: unknown; score?: unknown };
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Labels that are usually the same parked or passing vehicle seen again. A car
 * sitting in the driveway re-triggers every few minutes; it is the least
 * interesting thing the cameras report. Everything else (people, animals,
 * packages...) is never folded, so a second person is always its own row.
 */
const REPEAT_LABELS = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'boat', 'vehicle']);

/** Repeats of the same vehicle on the same camera and zone closer together than this are one row. */
const REPEAT_WINDOW_SECONDS = 30 * 60;

/** Rows kept after folding. The panel shows fewer; the slack covers a burst of folded repeats. */
const MAX_EVENTS = 8;

/** How many raw events to pull so folding still leaves enough distinct rows. */
const FETCH_LIMIT = 100;

/**
 * Folds near-duplicate vehicle detections. Input is newest first, as Frigate
 * returns it. A vehicle event joins the group already kept for the same
 * camera + label + zones when it started within the window of that group's
 * earliest member, so a car that stays parked chains into a single row however
 * long it sits. The newest event represents the group (its clip is the one to
 * open) and `count` records how many were folded in.
 */
export function collapseRepeats(events: FrigateEvent[]): FrigateEvent[] {
  const kept: FrigateEvent[] = [];
  const earliest = new Map<FrigateEvent, number>();
  const open = new Map<string, FrigateEvent>();

  for (const event of events) {
    if (!REPEAT_LABELS.has(event.label) || event.startTime === null) {
      kept.push(event);
      continue;
    }
    const key = `${event.camera}|${event.label}|${[...event.zones].sort().join(',')}`;
    const group = open.get(key);
    const groupStart = group ? earliest.get(group) : undefined;
    if (group && groupStart !== undefined && groupStart - event.startTime <= REPEAT_WINDOW_SECONDS) {
      group.count += event.count;
      earliest.set(group, Math.min(groupStart, event.startTime));
      continue;
    }
    kept.push(event);
    open.set(key, event);
    earliest.set(event, event.startTime);
  }
  return kept;
}

export function createFrigateSource(baseUrl: string) {
  return async function fetchFrigate(): Promise<FrigateSummary> {
    const [stats, events] = await Promise.all([
      getJson<RawStats>(`${baseUrl}/api/stats`),
      // Events are a nicety - a failure here should not blank the whole panel.
      getJson<RawEvent[]>(`${baseUrl}/api/events?limit=${FETCH_LIMIT}`).catch(() => [] as RawEvent[]),
    ]);

    const cameras: FrigateCameraStat[] = Object.entries(stats.cameras ?? {}).map(([name, raw]) => ({
      name,
      cameraFps: toNumber(raw['camera_fps']),
      detectionFps: toNumber(raw['detection_fps']),
      processFps: toNumber(raw['process_fps']),
      skippedFps: toNumber(raw['skipped_fps']),
    }));

    const detectors: FrigateDetectorStat[] = Object.entries(stats.detectors ?? {}).map(([name, raw]) => ({
      name,
      inferenceSpeedMs: toNumber(raw['inference_speed']),
    }));

    const storage: FrigateStorage[] = Object.entries(stats.service?.storage ?? {}).map(([mount, raw]) => ({
      mount,
      totalMb: toNumber(raw['total']),
      usedMb: toNumber(raw['used']),
      freeMb: toNumber(raw['free']),
    }));

    const parsedEvents: FrigateEvent[] = events
      .filter((event): event is RawEvent & { id: string } => typeof event.id === 'string')
      .map((event) => ({
        id: event.id,
        camera: toStringOrNull(event.camera) ?? 'unknown',
        label: toStringOrNull(event.label) ?? 'unknown',
        startTime: toNumber(event.start_time),
        endTime: toNumber(event.end_time),
        // 0.14+ moved the score into `data`; older builds keep it at the top level.
        score: toNumber(event.data?.top_score) ?? toNumber(event.data?.score) ?? toNumber(event.top_score),
        hasSnapshot: event.has_snapshot === true,
        hasClip: event.has_clip === true,
        zones: Array.isArray(event.zones) ? event.zones.filter((z): z is string => typeof z === 'string') : [],
        count: 1,
      }));
    const recentEvents = collapseRepeats(parsedEvents).slice(0, MAX_EVENTS);

    return {
      version: toStringOrNull(stats.service?.version),
      uptimeSeconds: toNumber(stats.service?.uptime),
      cameras,
      detectors,
      storage,
      recentEvents,
    };
  };
}
