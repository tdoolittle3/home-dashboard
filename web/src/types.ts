// Mirrors the payload built in server/src/snapshot.ts. Kept as a hand-written
// copy rather than a shared workspace so the frontend needs no build ordering;
// if you change the server payload, change this too.

export interface EntitySnapshot {
  entity_id: string;
  state: string;
  friendlyName: string | null;
  unit: string | null;
  deviceClass: string | null;
  icon: string | null;
  lastChanged: string | null;
  missing: boolean;
}

export interface HaStatus {
  connected: boolean;
  version: string | null;
  lastError: string | null;
  authFailed: boolean;
}

export interface EntityRef {
  entity_id: string;
  name?: string;
}

export interface CameraRef {
  name: string;
  label?: string;
}

export type SystemMetricKind = 'uptime' | 'percent' | 'value';

export interface SystemMetricRef extends EntityRef {
  kind?: SystemMetricKind;
  warn?: number;
  crit?: number;
}

export type Panel =
  | {
      id: string;
      title: string;
      type: 'entities';
      entities: EntityRef[];
      /** Draw the largest filesystem Frigate reports above the rows. */
      chart?: 'disk';
    }
  | { id: string; title: string; type: 'controls'; entities: EntityRef[] }
  | { id: string; title: string; type: 'cameras'; cameras: CameraRef[]; refreshSeconds?: number }
  | { id: string; title: string; type: 'system'; metrics: SystemMetricRef[] };

export interface DashboardConfig {
  title: string;
  panels: Panel[];
  links: { label: string; url: string }[];
}

export type SourceResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface FrigateSummary {
  version: string | null;
  uptimeSeconds: number | null;
  cameras: {
    name: string;
    cameraFps: number | null;
    detectionFps: number | null;
    processFps: number | null;
    skippedFps: number | null;
  }[];
  detectors: { name: string; inferenceSpeedMs: number | null }[];
  storage: { mount: string; totalMb: number | null; usedMb: number | null; freeMb: number | null }[];
  recentEvents: {
    id: string;
    camera: string;
    label: string;
    startTime: number | null;
    endTime: number | null;
    score: number | null;
    hasSnapshot: boolean;
    hasClip: boolean;
  }[];
}

export interface JellyfinSummary {
  serverName: string | null;
  version: string | null;
  sessions: {
    user: string | null;
    client: string | null;
    device: string | null;
    nowPlaying: string | null;
    paused: boolean;
  }[];
  counts: Record<string, number> | null;
}

export interface KumaSummary {
  monitors: {
    name: string;
    type: string | null;
    status: 'up' | 'down' | 'pending' | 'maintenance' | 'unknown';
    responseTimeMs: number | null;
    certDaysRemaining: number | null;
  }[];
  up: number;
  down: number;
}

export interface SourcesSnapshot {
  frigate: SourceResult<FrigateSummary> | null;
  jellyfin: SourceResult<JellyfinSummary> | null;
  uptimeKuma: SourceResult<KumaSummary> | null;
}

export interface Snapshot {
  generatedAt: string;
  dashboard: DashboardConfig;
  ha: HaStatus;
  entities: Record<string, EntitySnapshot>;
  sources: SourcesSnapshot;
}

export type ControlAction = 'turn_on' | 'turn_off' | 'toggle';
