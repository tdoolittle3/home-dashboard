import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { registerPhotosRoutes } from '../src/routes/photos.js';

const IMMICH = { baseUrl: 'http://immich.invalid', apiKey: 'secret' };

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    immich: IMMICH,
    dashboard: { title: 'Home', panels: [], links: [], tv: { slideshow: { album: 'album-1' } } },
    ...over,
  } as AppConfig;
}

describe('photos routes', () => {
  let app: FastifyInstance;
  let fetchMock: ReturnType<typeof vi.fn>;

  async function start(config: AppConfig) {
    app = Fastify();
    registerPhotosRoutes(app, config);
    await app.ready();
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app?.close();
  });

  describe('GET /api/photos/slideshow', () => {
    it('503s when no album is configured', async () => {
      await start(makeConfig({ dashboard: { title: 'Home', panels: [], links: [] } } as Partial<AppConfig>));
      const res = await app.inject({ url: '/api/photos/slideshow' });
      expect(res.statusCode).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('503s when immich is not configured', async () => {
      await start(makeConfig({ immich: null }));
      expect((await app.inject({ url: '/api/photos/slideshow' })).statusCode).toBe(503);
    });

    it('lists the album image ids, dropping videos and odd ids', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            assets: [
              { id: 'aaa', type: 'IMAGE' },
              { id: 'bbb', type: 'VIDEO' },
              { id: '../../etc', type: 'IMAGE' },
              { id: 'ccc', type: 'IMAGE' },
            ],
          }),
          { status: 200 },
        ),
      );
      await start(makeConfig());
      const res = await app.inject({ url: '/api/photos/slideshow' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { assets: string[] };
      expect([...body.assets].sort()).toEqual(['aaa', 'ccc']);

      const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(url).toBe('http://immich.invalid/api/albums/album-1');
      expect(init.headers['x-api-key']).toBe('secret');
    });

    it('serves repeat requests from the cache', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ assets: [{ id: 'aaa', type: 'IMAGE' }] })));
      await start(makeConfig());
      await app.inject({ url: '/api/photos/slideshow' });
      await app.inject({ url: '/api/photos/slideshow' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('502s with the reason when immich is down', async () => {
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
      await start(makeConfig());
      const res = await app.inject({ url: '/api/photos/slideshow' });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toContain('ECONNREFUSED');
    });
  });

  describe('GET /api/photos/:id/preview', () => {
    it('rejects an id that could escape the URL path', async () => {
      await start(makeConfig());
      const res = await app.inject({ url: '/api/photos/..%2F..%2Fusers/preview' });
      expect(res.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('streams the preview bytes with long caching', async () => {
      fetchMock.mockResolvedValue(
        new Response(Buffer.from('jpegbytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      );
      await start(makeConfig());
      const res = await app.inject({ url: '/api/photos/aaa/preview' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('jpegbytes');
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toContain('immutable');

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe('http://immich.invalid/api/assets/aaa/thumbnail?size=preview');
    });

    it('404s when immich does not know the asset', async () => {
      fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
      await start(makeConfig());
      expect((await app.inject({ url: '/api/photos/aaa/preview' })).statusCode).toBe(404);
    });

    it('502s when immich is down', async () => {
      fetchMock.mockRejectedValue(new Error('boom'));
      await start(makeConfig());
      expect((await app.inject({ url: '/api/photos/aaa/preview' })).statusCode).toBe(502);
    });
  });
});
