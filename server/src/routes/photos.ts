import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { cached, fetchWithTimeout } from '../sources/http.js';

/** Asset ids ride URL paths we build against Immich, so only uuid-shaped ids pass. */
const ASSET_ID = /^[A-Za-z0-9-]+$/;

/** How long one album listing serves /api/photos/slideshow before Immich is asked again. */
const ALBUM_TTL_MS = 5 * 60 * 1000;

interface RawSearchPage {
  assets?: { items?: { id?: unknown }[]; nextPage?: unknown };
}

/** Safety stop so a misbehaving server cannot page forever. */
const MAX_PAGES = 20;

/** Fisher-Yates, so the TV does not replay the album in upload order every cycle. */
function shuffled(ids: string[]): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The /tv slideshow's door to Immich. The browser never sees Immich or its
 * key - the same rule the Frigate media follows: browser-facing media rides
 * the dashboard origin, the server holds the credential.
 */
export function registerPhotosRoutes(app: FastifyInstance, config: AppConfig): void {
  const immich = config.immich;
  const slideshow = config.dashboard.tv?.slideshow;

  /** Null when everything needed is configured, else the message the client shows. */
  const missing = !slideshow
    ? 'no slideshow album in dashboard.json (tv.slideshow.album)'
    : !immich
      ? 'IMMICH_BASE_URL and IMMICH_API_KEY are not set'
      : null;

  const headers: Record<string, string> = immich
    ? { 'x-api-key': immich.apiKey, Accept: 'application/json' }
    : {};

  // GET /albums/:id no longer carries the asset list on current Immich, so the
  // album's images come from metadata search filtered to the album.
  const fetchAlbumIds = cached(ALBUM_TTL_MS, async (): Promise<string[]> => {
    const ids: string[] = [];
    let page: string | null = '1';
    for (let n = 0; page && n < MAX_PAGES; n++) {
      const response = await fetchWithTimeout(`${immich!.baseUrl}/api/search/metadata`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ albumIds: [slideshow!.album], type: 'IMAGE', size: 1000, page: Number(page) }),
        timeoutMs: 10_000,
      });
      if (!response.ok) throw new Error(`immich answered ${response.status}`);
      const body = (await response.json()) as RawSearchPage;
      for (const item of body.assets?.items ?? []) {
        if (typeof item.id === 'string' && ASSET_ID.test(item.id)) ids.push(item.id);
      }
      page = typeof body.assets?.nextPage === 'string' ? body.assets.nextPage : null;
    }
    return ids;
  });

  app.get('/api/photos/slideshow', async (_request, reply) => {
    if (missing) return reply.code(503).send({ error: missing });
    try {
      return await reply.send({ assets: shuffled(await fetchAlbumIds()) });
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string } }>('/api/photos/:id/preview', async (request, reply) => {
    if (missing) return reply.code(503).send({ error: missing });
    const { id } = request.params;
    if (!ASSET_ID.test(id)) return reply.code(400).send({ error: 'invalid asset id' });

    let upstream: Response;
    try {
      // size=preview is Immich's screen-sized JPEG - right for a 1080p TV,
      // a fraction of the original's weight.
      upstream = await fetchWithTimeout(`${immich!.baseUrl}/api/assets/${id}/thumbnail?size=preview`, {
        headers: { 'x-api-key': immich!.apiKey },
        timeoutMs: 15_000,
      });
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }

    if (!upstream.ok || !upstream.body) {
      return reply.code(upstream.status === 404 ? 404 : 502).send({ error: `immich answered ${upstream.status}` });
    }

    reply.header('Content-Type', upstream.headers.get('content-type') ?? 'image/jpeg');
    // An asset id always names the same picture, so the TV never refetches one
    // it has shown - the cache does the slideshow's second lap for free.
    reply.header('Cache-Control', 'public, max-age=86400, immutable');
    return reply.send(Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>));
  });
}
