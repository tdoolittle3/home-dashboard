import { getJson } from './http.js';

export interface AdguardTopEntry {
  name: string;
  count: number;
}

export interface AdguardQuery {
  domain: string;
  client: string | null;
  /** True when AdGuard answered from a blocklist rather than resolving. */
  blocked: boolean;
  reason: string | null;
  /** RFC3339 timestamp of the lookup, as AdGuard reports it. */
  time: string | null;
}

export interface AdguardSummary {
  running: boolean;
  protectionEnabled: boolean;
  version: string | null;
  /** Today's totals; zero before the router cutover, which is expected, not broken. */
  queries: number;
  blocked: number;
  /** null when there are no queries yet, so the UI never divides by zero. */
  blockedPercent: number | null;
  avgProcessingMs: number | null;
  topBlocked: AdguardTopEntry[];
  topClients: AdguardTopEntry[];
  recentQueries: AdguardQuery[];
  /** True when AdGuard stopped answering and this is its last good data. */
  stale: boolean;
  lastError: string | null;
}

/** Stats move slowly; the query log is the live ticker. */
const STATS_INTERVAL_MS = 30_000;
const QUERYLOG_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 300_000;
const QUERYLOG_LIMIT = 20;
const TOP_LIMIT = 5;

interface RawStatus {
  version?: unknown;
  running?: unknown;
  protection_enabled?: unknown;
}

interface RawStats {
  num_dns_queries?: unknown;
  num_blocked_filtering?: unknown;
  /** Seconds, not ms. */
  avg_processing_time?: unknown;
  top_blocked_domains?: unknown;
  top_clients?: unknown;
}

interface RawQuerylogEntry {
  question?: { name?: unknown } | null;
  client?: unknown;
  reason?: unknown;
  time?: unknown;
}

interface RawQuerylog {
  data?: RawQuerylogEntry[];
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** AdGuard's top-N lists are arrays of single-pair objects: [{"dns.example": 42}, ...]. */
function topEntries(value: unknown): AdguardTopEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: AdguardTopEntry[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const [pair] = Object.entries(item as Record<string, unknown>);
    if (pair && typeof pair[1] === 'number' && Number.isFinite(pair[1]) && pair[1] > 0) {
      entries.push({ name: pair[0], count: pair[1] });
    }
    if (entries.length >= TOP_LIMIT) break;
  }
  return entries;
}

/**
 * Rate-limits one endpoint and remembers its last good answer. A failure pushes
 * the next attempt out (doubling per consecutive miss, capped at five minutes)
 * while the stale value keeps serving. This resolver is about to carry the
 * whole house's DNS, so the dashboard neither hammers it when it struggles nor
 * declares it down over a single missed poll.
 */
function paced<T>(intervalMs: number, fetcher: () => Promise<T>) {
  let value: T | null = null;
  let error: string | null = null;
  let failures = 0;
  let nextAt = 0;
  let inFlight: Promise<void> | null = null;

  return async (): Promise<{ value: T | null; error: string | null }> => {
    if (Date.now() >= nextAt || inFlight) {
      inFlight ??= fetcher()
        .then((fresh) => {
          value = fresh;
          error = null;
          failures = 0;
          nextAt = Date.now() + intervalMs;
        })
        .catch((cause: unknown) => {
          failures += 1;
          error = cause instanceof Error ? cause.message : String(cause);
          nextAt = Date.now() + Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);
        })
        .finally(() => {
          inFlight = null;
        });
      await inFlight;
    }
    return { value, error };
  };
}

/**
 * AdGuard Home's admin API: every /control/* endpoint wants the UI login as
 * HTTP basic auth, which is why the server polls it and the browser never
 * does. Read-only on purpose - status, stats and the query log; no protection
 * toggle, because writes on this dashboard are HA-entity-only by design.
 */
export function createAdguardSource(baseUrl: string, username: string, password: string) {
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

  const status = paced(STATS_INTERVAL_MS, () => getJson<RawStatus>(`${baseUrl}/control/status`, { headers }));
  const stats = paced(STATS_INTERVAL_MS, () => getJson<RawStats>(`${baseUrl}/control/stats`, { headers }));
  const querylog = paced(QUERYLOG_INTERVAL_MS, () =>
    getJson<RawQuerylog>(`${baseUrl}/control/querylog?limit=${QUERYLOG_LIMIT}`, { headers }),
  );

  return async function fetchAdguard(): Promise<AdguardSummary> {
    const [st, sm, log] = await Promise.all([status(), stats(), querylog()]);

    // Nothing has ever answered: genuinely unreachable, not a blip mid-stream.
    if (st.value === null && sm.value === null) {
      throw new Error(st.error ?? sm.error ?? 'no response');
    }

    const queries = toNumber(sm.value?.num_dns_queries) ?? 0;
    const blocked = toNumber(sm.value?.num_blocked_filtering) ?? 0;
    const avgSeconds = toNumber(sm.value?.avg_processing_time);
    const lastError = st.error ?? sm.error ?? log.error;

    return {
      running: st.value?.running === true,
      protectionEnabled: st.value?.protection_enabled === true,
      version: toStringOrNull(st.value?.version),
      queries,
      blocked,
      blockedPercent: queries > 0 ? (blocked / queries) * 100 : null,
      avgProcessingMs: avgSeconds !== null ? avgSeconds * 1000 : null,
      topBlocked: topEntries(sm.value?.top_blocked_domains),
      topClients: topEntries(sm.value?.top_clients),
      recentQueries: (log.value?.data ?? []).map((entry) => {
        const reason = toStringOrNull(entry.reason);
        return {
          domain: toStringOrNull(entry.question?.name) ?? '?',
          client: toStringOrNull(entry.client),
          // "FilteredBlackList", "FilteredSafeBrowsing"... vs "NotFiltered*".
          blocked: reason !== null && reason.startsWith('Filtered'),
          reason,
          time: toStringOrNull(entry.time),
        };
      }),
      stale: lastError !== null,
      lastError,
    };
  };
}
