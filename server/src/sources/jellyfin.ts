import { getJson } from './http.js';

export interface JellyfinSession {
  user: string | null;
  client: string | null;
  device: string | null;
  nowPlaying: string | null;
  paused: boolean;
  /** 0-100 through the current item, when something is playing. */
  progressPercent: number | null;
  lastActivity: string | null;
}

export interface JellyfinRecentItem {
  id: string;
  name: string;
  /** Movie, Series, Episode, Audio... as Jellyfin names them. */
  type: string | null;
  series: string | null;
  year: number | null;
  addedAt: string | null;
}

export interface JellyfinSummary {
  serverName: string | null;
  version: string | null;
  /** Sessions active in the last quarter hour, playing or not. */
  sessions: JellyfinSession[];
  /** How many of those sessions are actually playing something. */
  playing: number;
  counts: Record<string, number> | null;
  recentlyAdded: JellyfinRecentItem[];
}

/** Sessions that have not touched the server in this long are stale clients, not viewers. */
const SESSION_ACTIVE_WITHIN_SECONDS = 900;
const RECENT_LIMIT = 6;

interface RawSystemInfo {
  ServerName?: unknown;
  Version?: unknown;
}

interface RawSession {
  UserName?: unknown;
  Client?: unknown;
  DeviceName?: unknown;
  LastActivityDate?: unknown;
  NowPlayingItem?: { Name?: unknown; SeriesName?: unknown; RunTimeTicks?: unknown } | null;
  PlayState?: { IsPaused?: unknown; PositionTicks?: unknown } | null;
}

interface RawItem {
  Id?: unknown;
  Name?: unknown;
  Type?: unknown;
  SeriesName?: unknown;
  ProductionYear?: unknown;
  DateCreated?: unknown;
}

interface RawItemsPage {
  Items?: RawItem[];
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function describeNowPlaying(item: RawSession['NowPlayingItem']): string | null {
  if (!item) return null;
  const name = toStringOrNull(item.Name);
  const series = toStringOrNull(item.SeriesName);
  if (name && series) return `${series} - ${name}`;
  return name ?? series;
}

function progressOf(session: RawSession): number | null {
  const position = toNumber(session.PlayState?.PositionTicks);
  const runtime = toNumber(session.NowPlayingItem?.RunTimeTicks);
  if (position === null || runtime === null || runtime <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((position / runtime) * 100)));
}

/**
 * Jellyfin authenticates with an API key (Dashboard -> API Keys) in the
 * `X-Emby-Token` header. Only /System/Info and /Sessions are required; the
 * library counts and the recently-added list are niceties that have shifted
 * between versions, so either failing leaves the rest of the panel standing.
 */
export function createJellyfinSource(baseUrl: string, apiKey: string) {
  const headers = { 'X-Emby-Token': apiKey, Accept: 'application/json' };

  const recentQuery = new URLSearchParams({
    SortBy: 'DateCreated',
    SortOrder: 'Descending',
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series,Episode,Audio',
    Fields: 'DateCreated',
    EnableImages: 'false',
    Limit: String(RECENT_LIMIT),
  });

  return async function fetchJellyfin(): Promise<JellyfinSummary> {
    const [info, sessions, counts, recent] = await Promise.all([
      getJson<RawSystemInfo>(`${baseUrl}/System/Info`, { headers }),
      getJson<RawSession[]>(`${baseUrl}/Sessions?ActiveWithinSeconds=${SESSION_ACTIVE_WITHIN_SECONDS}`, {
        headers,
      }),
      // /Items/Counts has come and gone across Jellyfin versions - treat it as optional.
      getJson<Record<string, unknown>>(`${baseUrl}/Items/Counts`, { headers }).catch(() => null),
      getJson<RawItemsPage>(`${baseUrl}/Items?${recentQuery}`, { headers }).catch(() => null),
    ]);

    const mappedSessions: JellyfinSession[] = sessions.map((session) => ({
      user: toStringOrNull(session.UserName),
      client: toStringOrNull(session.Client),
      device: toStringOrNull(session.DeviceName),
      nowPlaying: describeNowPlaying(session.NowPlayingItem),
      paused: session.PlayState?.IsPaused === true,
      progressPercent: progressOf(session),
      lastActivity: toStringOrNull(session.LastActivityDate),
    }));

    return {
      serverName: toStringOrNull(info.ServerName),
      version: toStringOrNull(info.Version),
      sessions: mappedSessions,
      playing: mappedSessions.filter((session) => session.nowPlaying !== null).length,
      counts: counts
        ? Object.fromEntries(
            Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
          )
        : null,
      recentlyAdded: (recent?.Items ?? [])
        .filter((item): item is RawItem & { Id: string } => typeof item.Id === 'string')
        .map((item) => ({
          id: item.Id,
          name: toStringOrNull(item.Name) ?? 'untitled',
          type: toStringOrNull(item.Type),
          series: toStringOrNull(item.SeriesName),
          year: toNumber(item.ProductionYear),
          addedAt: toStringOrNull(item.DateCreated),
        })),
    };
  };
}
