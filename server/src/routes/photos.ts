import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { cached, fetchWithTimeout, getJson } from '../sources/http.js';

/** Asset ids ride URL paths we build against Immich, so only uuid-shaped ids pass. */
const ASSET_ID = /^[A-Za-z0-9-]+$/;

/** How long one album listing serves /api/photos/slideshow before Immich is asked again. */
const ALBUM_TTL_MS = 5 * 60 * 1000;

interface RawAlbum {
  assets?: { id?: unknown; type?: unknown }[];
}

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

  const fetchAlbumIds = cached(ALBUM_TTL_MS, async (): Promise<string[]> => {
    const album = await getJson<RawAlbum>(`${immich!.baseUrl}/api/albums/${slideshow!.album}`, {
      headers,
      timeoutMs: 10_000,
    });
    return (album.assets ?? [])
      .filter((asset) => asset.type === 'IMAGE' && typeof asset.id === 'string' && ASSET_ID.test(asset.id))
      .map((asset) => asset.id as string);
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
