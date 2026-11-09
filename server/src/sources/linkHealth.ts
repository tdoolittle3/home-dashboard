import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ServiceLink } from '../config.js';
import { fetchWithTimeout } from './http.js';

export interface LinkHealth {
  label: string;
  up: boolean;
  /** HTTP status when something answered; null when the connection failed. */
  status: number | null;
  latencyMs: number | null;
  /** Why the dot is red when down. */
  error: string | null;
}

const TIMEOUT_MS = 4_000;

/**
 * A reverse proxy answering for a dead backend. Any other status - a 401, a
 * redirect, even a 500 - is still the service itself talking, but these three
 * are the proxy saying nobody is home (the tailscale-served links would
 * otherwise stay green forever).
 */
const GATEWAY_DOWN = new Set([502, 503, 504]);

/**
 * GET `url` but dial `address` instead of resolving the hostname - the
 * container has no DNS for tailnet names. The URL keeps the real hostname, so
 * SNI and certificate verification still check against it; only the DNS step
 * is skipped. Plain fetch offers no lookup hook, hence node's own clients.
 */
function probePinned(url: string, address: string, timeoutMs: number): Promise<number> {
  const target = new URL(url);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const family = address.includes(':') ? 6 : 4;
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        lookup: (_hostname, options, callback) => {
          // net may ask for one address or (autoSelectFamily) all of them.
          if (options.all) (callback as unknown as (e: null, a: unknown[]) => void)(null, [{ address, family }]);
          else callback(null, address, family);
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Liveness pings for the generic link tiles. "Up" means the service answered
 * HTTP - a 401 or a redirect is still a running service, so the status code is
 * reported but only a refused connection, a timeout or a gateway error (the
 * proxy covering for a dead backend) turns the dot red. One bad target
 * degrades one tile, so each ping catches its own error rather than the set
 * sharing a toResult.
 */
export function createLinkHealthSource(links: ServiceLink[]): () => Promise<LinkHealth[]> {
  const targets = links.filter((link) => link.health !== undefined);

  return async () =>
    Promise.all(
      targets.map(async (link): Promise<LinkHealth> => {
        const started = Date.now();
        try {
          let status: number;
          if (link.resolve !== undefined) {
            status = await probePinned(link.health as string, link.resolve, TIMEOUT_MS);
          } else {
            const response = await fetchWithTimeout(link.health as string, { timeoutMs: TIMEOUT_MS });
            // The body is irrelevant; drain it so the socket is released.
            await response.arrayBuffer().catch(() => undefined);
            status = response.status;
          }
          const latencyMs = Date.now() - started;
          if (GATEWAY_DOWN.has(status)) {
            return { label: link.label, up: false, status, latencyMs, error: `HTTP ${status} from the proxy` };
          }
          return { label: link.label, up: true, status, latencyMs, error: null };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { label: link.label, up: false, status: null, latencyMs: null, error: message };
        }
      }),
    );
}
