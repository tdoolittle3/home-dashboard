import { getJson } from './http.js';

export interface JellyfinSession {
  user: string | null;
  client: string | null;
  device: string | null;
  nowPlaying: string | null;
  paused: boolean;
}

export interface JellyfinSummary {
  serverName: string | null;
  version: string | null;
  sessions: JellyfinSession[];
  counts: Record<string, number> | null;
}

interface RawSystemInfo {
  ServerName?: unknown;
  Version?: unknown;
}

interface RawSession {
  UserName?: unknown;
  Client?: unknown;
  DeviceName?: unknown;
  NowPlayingItem?: { Name?: unknown; SeriesName?: unknown } | null;
  PlayState?: { IsPaused?: unknown } | null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function describeNowPlaying(item: RawSession['NowPlayingItem']): string | null {
  if (!item) return null;
  const name = toStringOrNull(item.Name);
  const series = toStringOrNull(item.SeriesName);
  if (name && series) return `${series} - ${name}`;
  return name ?? series;
}

export function createJellyfinSource(baseUrl: string, apiKey: string) {
  const headers = { 'X-Emby-Token': apiKey, Accept: 'application/json' };

  return async function fetchJellyfin(): Promise<JellyfinSummary> {
    const [info, sessions, counts] = await Promise.all([
      getJson<RawSystemInfo>(`${baseUrl}/System/Info`, { headers }),
      getJson<RawSession[]>(`${baseUrl}/Sessions`, { headers }),
      // /Items/Counts has come and gone across Jellyfin versions - treat it as optional.
      getJson<Record<string, unknown>>(`${baseUrl}/Items/Counts`, { headers }).catch(() => null),
    ]);

    return {
      serverName: toStringOrNull(info.ServerName),
      version: toStringOrNull(info.Version),
      sessions: sessions.map((session) => ({
        user: toStringOrNull(session.UserName),
        client: toStringOrNull(session.Client),
        device: toStringOrNull(session.DeviceName),
        nowPlaying: describeNowPlaying(session.NowPlayingItem),
        paused: session.PlayState?.IsPaused === true,
      })),
      counts: counts
        ? Object.fromEntries(
            Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
          )
        : null,
    };
  };
}
