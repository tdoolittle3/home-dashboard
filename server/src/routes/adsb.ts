import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

/** RFC 9110 hop-by-hop headers: meaningful per connection, never relayed. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

/** The server speaks for itself (host) and lets undici negotiate compression. */
const REQUEST_DROP = new Set([...HOP_BY_HOP, 'host', 'accept-encoding', 'content-length']);

/** undici already decoded the body, so the upstream encoding headers would describe bytes the browser never sees. */
const RESPONSE_DROP = new Set([...HOP_BY_HOP, 'content-encoding', 'content-length']);

/** tar1090 answers from memory; anything slower than this is the receiver being down, not thinking. */
const HEADER_TIMEOUT_MS = 15_000;

/**
 * Same-origin gateway to the ADS-B receiver: /adsb/* relays to tar1090.
 * The dashboard is also served over Tailscale HTTPS (tailscale serve), and on
 * that origin the browser blocks the panel's plain-http iframe and
 * aircraft.json poll as mixed content - top-level links still open, embedded
 * subresources never load. So tar1090 follows the rule the Frigate media and
 * snibbly already follow: browser-facing traffic rides the dashboard origin.
 * GET only - tar1090 is a viewer, nothing behind it takes writes - and its
 * pages use strictly relative asset paths, so it serves happily under the
 * /adsb/ prefix.
 */
export function registerAdsbRoutes(app: FastifyInstance, config: AppConfig): void {
  const adsb = config.adsb;
  if (!adsb) return;

  app.get('/adsb', async (_request, reply) => reply.redirect('/adsb/'));

  app.get('/adsb/*', async (request, reply) => {
    // raw.url keeps the query string (?hideButtons) and any percent-encoding verbatim.
    const target = `${adsb.baseUrl}${request.raw.url?.slice('/adsb'.length) ?? '/'}`;

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || REQUEST_DROP.has(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }

    const controller = new AbortController();
    const headerTimer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
    reply.raw.on('close', () => {
      clearTimeout(headerTimer);
      controller.abort();
    });

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers,
        // Redirects go back to the browser so its address bar stays honest.
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      // The panel reads any non-ok status as its "receiver offline" state.
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(headerTimer);
    }

    reply.code(upstream.status);
    upstream.headers.forEach((value, name) => {
      if (!RESPONSE_DROP.has(name)) void reply.header(name, value);
    });
    // Upstream redirects name their paths from tar1090's root; pull them back
    // under the proxy so the browser does not land on the dashboard's own 404.
    const location = upstream.headers.get('location');
    if (location?.startsWith('/')) void reply.header('location', `/adsb${location}`);

    if (!upstream.body) return reply.send();
    return reply.send(Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>));
  });
}
