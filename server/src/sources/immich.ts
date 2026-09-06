import { getJson } from './http.js';

export interface ImmichUserUsage {
  name: string;
  photos: number;
  videos: number;
  usageBytes: number;
  quotaBytes: number | null;
}

export interface ImmichJobQueue {
  name: string;
  active: number;
  waiting: number;
  failed: number;
  paused: boolean;
}

export interface ImmichSummary {
  version: string | null;
  /** Library totals. Null when the key is not an admin's - /server/statistics is admin-only. */
  library: {
    photos: number;
    videos: number;
    usageBytes: number;
    users: ImmichUserUsage[];
  } | null;
  /** The filesystem the upload location sits on, as Immich sees it from inside its container. */
  disk: {
    sizeBytes: number | null;
    usedBytes: number | null;
    availableBytes: number | null;
    usagePercent: number | null;
  } | null;
  /** Background work: thumbnails, ML, transcoding. Null when the key is not an admin's. */
  jobs: {
    active: number;
    waiting: number;
    failed: number;
    queues: ImmichJobQueue[];
  } | null;
}

/**
 * Immich's REST API authenticates with an API key (Account settings -> API Keys)
 * sent as `x-api-key`. Everything is read from `/api/server/*` and `/api/jobs`.
 *
 * Only `/server/about` is required: it doubles as the auth check. The statistics
 * and job endpoints need the key to belong to an admin, so a non-admin key still
 * gets a working tile with disk figures and a version, and the panel says what
 * is missing instead of going red.
 */
interface RawAbout {
  version?: unknown;
}

interface RawStatistics {
  photos?: unknown;
  videos?: unknown;
  usage?: unknown;
  usageByUser?: {
    userName?: unknown;
    photos?: unknown;
    videos?: unknown;
    usage?: unknown;
    quotaSizeInBytes?: unknown;
  }[];
}

interface RawStorage {
  diskSizeRaw?: unknown;
  diskUseRaw?: unknown;
  diskAvailableRaw?: unknown;
  diskUsagePercentage?: unknown;
}

interface RawQueue {
  jobCounts?: { active?: unknown; waiting?: unknown; failed?: unknown; delayed?: unknown; paused?: unknown };
  queueStatus?: { isPaused?: unknown };
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Immich names queues in camelCase (`thumbnailGeneration`); space them for display. */
function humanizeQueue(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

export function createImmichSource(baseUrl: string, apiKey: string) {
  const headers = { 'x-api-key': apiKey, Accept: 'application/json' };
  const api = `${baseUrl}/api`;

  return async function fetchImmich(): Promise<ImmichSummary> {
    const [about, statistics, storage, jobs] = await Promise.all([
      getJson<RawAbout>(`${api}/server/about`, { headers }),
      getJson<RawStatistics>(`${api}/server/statistics`, { headers }).catch(() => null),
      getJson<RawStorage>(`${api}/server/storage`, { headers }).catch(() => null),
      getJson<Record<string, RawQueue>>(`${api}/jobs`, { headers }).catch(() => null),
    ]);

    let library: ImmichSummary['library'] = null;
    if (statistics && toNumber(statistics.photos) !== null) {
      library = {
        photos: toNumber(statistics.photos) ?? 0,
        videos: toNumber(statistics.videos) ?? 0,
        usageBytes: toNumber(statistics.usage) ?? 0,
        users: (statistics.usageByUser ?? [])
          .map((user) => ({
            name: toStringOrNull(user.userName) ?? 'unknown',
            photos: toNumber(user.photos) ?? 0,
            videos: toNumber(user.videos) ?? 0,
            usageBytes: toNumber(user.usage) ?? 0,
            quotaBytes: toNumber(user.quotaSizeInBytes),
          }))
          .sort((a, b) => b.usageBytes - a.usageBytes),
      };
    }

    const disk: ImmichSummary['disk'] = storage
      ? {
          sizeBytes: toNumber(storage.diskSizeRaw),
          usedBytes: toNumber(storage.diskUseRaw),
          availableBytes: toNumber(storage.diskAvailableRaw),
          usagePercent: toNumber(storage.diskUsagePercentage),
        }
      : null;

    let jobSummary: ImmichSummary['jobs'] = null;
    if (jobs && typeof jobs === 'object') {
      const queues: ImmichJobQueue[] = Object.entries(jobs)
        .filter((entry): entry is [string, RawQueue] => typeof entry[1] === 'object' && entry[1] !== null)
        .map(([name, queue]) => ({
          name: humanizeQueue(name),
          active: toNumber(queue.jobCounts?.active) ?? 0,
          // Delayed and paused jobs are still queued work from the reader's point of view.
          waiting:
            (toNumber(queue.jobCounts?.waiting) ?? 0) +
            (toNumber(queue.jobCounts?.delayed) ?? 0) +
            (toNumber(queue.jobCounts?.paused) ?? 0),
          failed: toNumber(queue.jobCounts?.failed) ?? 0,
          paused: queue.queueStatus?.isPaused === true,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      jobSummary = {
        active: queues.reduce((sum, queue) => sum + queue.active, 0),
        waiting: queues.reduce((sum, queue) => sum + queue.waiting, 0),
        failed: queues.reduce((sum, queue) => sum + queue.failed, 0),
        queues,
      };
    }

    return {
      version: toStringOrNull(about.version),
      library,
      disk,
      jobs: jobSummary,
    };
  };
}
