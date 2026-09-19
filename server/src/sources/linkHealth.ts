import type { ServiceLink } from '../config.js';
import { fetchWithTimeout } from './http.js';

export interface LinkHealth {
  label: string;
  up: boolean;
  /** HTTP status when the service answered; null when the connection failed. */
  status: number | null;
  latencyMs: number | null;
  /** The connection error when down. */
  error: string | null;
}

const TIMEOUT_MS = 4_000;

/**
 * Liveness pings for the generic link tiles. "Up" means the process answered
 * HTTP at all - a 401 or a redirect is still a running service, so the status
 * code is reported but never turns the dot red. Only a refused connection or a
 * timeout does. One bad target degrades one tile, so each ping catches its own
 * error rather than the set sharing a toResult.
 */
export function createLinkHealthSource(links: ServiceLink[]): () => Promise<LinkHealth[]> {
  const targets = links.filter((link) => link.health !== undefined);

  return async () =>
    Promise.all(
      targets.map(async (link): Promise<LinkHealth> => {
        const started = Date.now();
        try {
          const response = await fetchWithTimeout(link.health as string, { timeoutMs: TIMEOUT_MS });
          // The body is irrelevant; drain it so the socket is released.
          await response.arrayBuffer().catch(() => undefined);
          return { label: link.label, up: true, status: response.status, latencyMs: Date.now() - started, error: null };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { label: link.label, up: false, status: null, latencyMs: null, error: message };
        }
      }),
    );
}
