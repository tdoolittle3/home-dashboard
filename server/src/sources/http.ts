/** A source is either reporting data or reporting why it cannot. Never both, never neither. */
export type SourceResult<T> = { ok: true; data: T } | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 5_000;

export async function getJson<T>(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const response = await fetchWithTimeout(url, init);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
  return (await response.json()) as T;
}

export async function getText(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string> {
  const response = await fetchWithTimeout(url, init);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
  return await response.text();
}

export async function fetchWithTimeout(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: init.headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Wraps a fetcher so a dead service degrades one tile instead of the whole page. */
export async function toResult<T>(label: string, fetcher: () => Promise<T>): Promise<SourceResult<T>> {
  try {
    return { ok: true, data: await fetcher() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${label}: ${message}` };
  }
}

/**
 * Caches one value for `ttlMs`. In-flight calls share a promise, so twenty
 * browser tabs refreshing at once still make a single upstream request.
 */
export function cached<T>(ttlMs: number, fetcher: () => Promise<T>): () => Promise<T> {
  let value: T | null = null;
  let expiresAt = 0;
  let inFlight: Promise<T> | null = null;

  return async () => {
    if (value !== null && Date.now() < expiresAt) return value;
    if (inFlight) return inFlight;

    inFlight = fetcher()
      .then((fresh) => {
        value = fresh;
        expiresAt = Date.now() + ttlMs;
        return fresh;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };
}
