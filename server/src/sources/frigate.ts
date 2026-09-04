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
  data?: { top_score?: unknown; score?: unknown };
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function createFrigateSource(baseUrl: string) {
  return async function fetchFrigate(): Promise<FrigateSummary> {
    const [stats, events] = await Promise.all([
      getJson<RawStats>(`${baseUrl}/api/stats`),
      // Events are a nicety - a failure here should not blank the whole panel.
      getJson<RawEvent[]>(`${baseUrl}/api/events?limit=8`).catch(() => [] as RawEvent[]),
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

    const recentEvents: FrigateEvent[] = events
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
      }));

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
