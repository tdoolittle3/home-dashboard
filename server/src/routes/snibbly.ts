import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

/** RFC 9110 hop-by-hop headers: meaningful per connection, never relayed. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

/**
 * Dropped from the relayed request: the server speaks for itself (host), holds
 * the only credential (authorization), and lets undici negotiate and decode
 * compression (accept-encoding, content-length).
 */
const REQUEST_DROP = new Set([...HOP_BY_HOP, 'host', 'authorization', 'accept-encoding', 'content-length', 'expect']);

/**
 * Dropped from the relayed response: undici already decoded the body, so the
 * upstream encoding headers would describe bytes the browser never sees - and
 * a passed-through www-authenticate on a 401 would resurface the exact
 * password dialog this proxy exists to remove.
 */
const RESPONSE_DROP = new Set([...HOP_BY_HOP, 'content-encoding', 'content-length', 'www-authenticate']);

/** llama.cpp's webui takes image/audio attachments inline in the chat JSON. */
const PROXY_BODY_LIMIT = 64 * 1024 * 1024;

/** A cold model swap holds the first byte while llama-swap loads it; its own ceiling is healthCheckTimeout (minutes). Body is open-ended after that, like the camera streams. */
const PROXY_HEADER_TIMEOUT_MS = 300_000;

/**
 * Same-origin gateway to snibbly: /snibbly/* relays to llama-swap with the
 * API key attached server-side. llama-swap gates every page behind HTTP Basic
 * and iPhone Safari ignores credentials embedded in a link, so the only
 * prompt-free way in from the phone is the rule the Frigate media already
 * follows: browser-facing traffic rides the dashboard origin and the server
 * holds the key. The prefix is safe for both UIs behind it - llama-swap's
 * /ui is hash-routed and derives its API base from whatever precedes "/ui"
 * in the path, and llama.cpp's webui fetches strictly relative paths.
 */
export function registerSnibblyRoutes(app: FastifyInstance, config: AppConfig): void {
  const llamaSwap = config.llamaSwap;
  if (!llamaSwap) return;

  // An encapsulated context, so the raw-bytes body parser (a proxy must relay
  // bodies untouched, not re-serialize Fastify's parsed JSON) never leaks into
  // the real API routes.
  void app.register(async (instance) => {
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: PROXY_BODY_LIMIT }, (_request, body, done) =>
      done(null, body),
    );

    instance.all('/snibbly', async (_request, reply) => reply.redirect('/snibbly/ui/'));

    instance.all('/snibbly/*', async (request, reply) => {
      // raw.url keeps the query string and any percent-encoding verbatim.
      const target = `${llamaSwap.baseUrl}${request.raw.url?.slice('/snibbly'.length) ?? '/'}`;

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || REQUEST_DROP.has(name)) continue;
        headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      headers['authorization'] = `Bearer ${llamaSwap.apiKey}`;

      // Disconnect rides the RESPONSE: on a POST, request.raw closes with the
      // consumed body, long before the client goes anywhere (the /api/chat lesson).
      const controller = new AbortController();
      const headerTimer = setTimeout(() => controller.abort(), PROXY_HEADER_TIMEOUT_MS);
      reply.raw.on('close', () => {
        clearTimeout(headerTimer);
        controller.abort();
      });

      let upstream: Response;
      try {
        upstream = await fetch(target, {
          method: request.method,
          headers,
          body: Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : undefined,
          // Redirects go back to the browser so its address bar stays honest.
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(headerTimer);
      }

      reply.code(upstream.status);
      upstream.headers.forEach((value, name) => {
        if (!RESPONSE_DROP.has(name)) void reply.header(name, value);
      });
      // Upstream redirects name its paths from the root (/ -> /ui/); pull them
      // back under the proxy so the browser does not land on the dashboard's own 404.
      const location = upstream.headers.get('location');
      if (location?.startsWith('/')) void reply.header('location', `/snibbly${location}`);

      if (!upstream.body) return reply.send();
      return reply.send(Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>));
    });
  });
}
