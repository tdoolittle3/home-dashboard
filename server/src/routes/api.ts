import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { HaClient } from '../ha/client.js';
import type { SnapshotBuilder } from '../snapshot.js';
import { fetchWithTimeout } from '../sources/http.js';

const ACTIONS = new Set(['turn_on', 'turn_off', 'toggle']);

/** Frigate resizes on its side; keep the request inside what a dashboard tile can use. */
function clampHeight(raw: string | undefined): number {
  const requested = Number(raw);
  return Number.isFinite(requested) ? Math.min(Math.max(Math.round(requested), 90), 1080) : 360;
}

/** Frigate cannot serve faster than the camera's detect fps (5 here), so more is just wasted encoding. */
function clampFps(raw: string | undefined): number {
  const requested = Number(raw);
  return Number.isFinite(requested) ? Math.min(Math.max(Math.round(requested), 1), 10) : 5;
}

interface ActionBody {
  entity_id?: unknown;
  action?: unknown;
}

export function registerApiRoutes(
  app: FastifyInstance,
  config: AppConfig,
  ha: HaClient,
  snapshots: SnapshotBuilder,
): void {
  app.get('/api/health', async () => ({
    ok: true,
    ha: ha.status,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/api/dashboard', async () => snapshots.build());

  /**
   * The only write path. It refuses anything not listed in a `controls` panel,
   * so the HA token's full authority never becomes the dashboard's authority.
   */
  app.post('/api/action', async (request, reply) => {
    const body = (request.body ?? {}) as ActionBody;
    const entityId = typeof body.entity_id === 'string' ? body.entity_id : null;
    const action = typeof body.action === 'string' ? body.action : null;

    if (!entityId || !config.controllableEntities.has(entityId)) {
      return reply.code(403).send({ error: 'entity is not exposed by a controls panel' });
    }
    if (!action || !ACTIONS.has(action)) {
      return reply.code(400).send({ error: `action must be one of ${[...ACTIONS].join(', ')}` });
    }
    if (!ha.status.connected) {
      return reply.code(503).send({ error: 'Home Assistant is not connected' });
    }

    const domain = entityId.split('.')[0];
    if (!domain) return reply.code(400).send({ error: 'malformed entity_id' });

    try {
      await ha.callService(domain, action, entityId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ error: message });
    }

    // The resulting state arrives over /api/stream; do not guess it here.
    return reply.code(202).send({ accepted: true });
  });

  /**
   * Proxies Frigate stills so the browser needs no route to the camera island
   * and no knowledge of Frigate's unauthenticated port.
   */
  app.get<{ Params: { name: string }; Querystring: { h?: string } }>(
    '/api/camera/:name/snapshot',
    async (request, reply) => {
      const { name } = request.params;
      if (!config.proxyableCameras.has(name)) {
        return reply.code(404).send({ error: 'unknown camera' });
      }
      const frigate = config.frigate;
      if (!frigate) {
        return reply.code(503).send({ error: 'FRIGATE_BASE_URL is not configured' });
      }

      const height = clampHeight(request.query.h);

      try {
        const upstream = await fetchWithTimeout(`${frigate.baseUrl}/api/${name}/latest.jpg?h=${height}`, {
          timeoutMs: 8_000,
        });
        if (!upstream.ok) {
          return reply.code(502).send({ error: `frigate returned ${upstream.status}` });
        }
        const body = Buffer.from(await upstream.arrayBuffer());
        return reply
          .header('Content-Type', upstream.headers.get('content-type') ?? 'image/jpeg')
          .header('Cache-Control', 'no-store')
          .send(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(502).send({ error: message });
      }
    },
  );

  /**
   * Live view: pipes Frigate's MJPEG stream for a camera straight through to
   * the browser. Frigate JPEG-encodes every frame per connected viewer, so the
   * client abort is propagated upstream the moment a tab goes away - otherwise
   * Frigate keeps encoding for nobody until its own write fails.
   */
  app.get<{ Params: { name: string }; Querystring: { h?: string; fps?: string } }>(
    '/api/camera/:name/stream',
    async (request, reply) => {
      const { name } = request.params;
      if (!config.proxyableCameras.has(name)) {
        return reply.code(404).send({ error: 'unknown camera' });
      }
      const frigate = config.frigate;
      if (!frigate) {
        return reply.code(503).send({ error: 'FRIGATE_BASE_URL is not configured' });
      }

      const height = clampHeight(request.query.h);
      const fps = clampFps(request.query.fps);

      const controller = new AbortController();
      request.raw.on('close', () => controller.abort());
      // Only the wait for headers is bounded; the body is open-ended by design.
      const headerTimer = setTimeout(() => controller.abort(), 8_000);

      let upstream: Response;
      try {
        upstream = await fetch(`${frigate.baseUrl}/api/${name}?fps=${fps}&h=${height}`, {
          signal: controller.signal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(502).send({ error: message });
      } finally {
        clearTimeout(headerTimer);
      }

      if (!upstream.ok || !upstream.body) {
        return reply.code(502).send({ error: `frigate returned ${upstream.status}` });
      }

      return reply
        .header('Content-Type', upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace;boundary=frame')
        .header('Cache-Control', 'no-store')
        // Some reverse proxies buffer chunked bodies; MJPEG is useless buffered.
        .header('X-Accel-Buffering', 'no')
        .send(Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>));
    },
  );

  /*
   * Real video for the full-screen viewer, relayed from Frigate's bundled
   * go2rtc (reachable behind Frigate's port at /api/go2rtc). Two transports,
   * because no single one plays everywhere:
   *
   * - live.m3u8: HLS with fMP4 segments - the only thing iPhone Safari plays
   *   in a <video>, and Apple requires fMP4 rather than TS for H.265.
   * - live.mp4: one endless fMP4 stream - Chrome, Edge and Android, lower
   *   latency than HLS.
   *
   * A camera absent from go2rtc (or a browser without an H.265 decoder) makes
   * the <video> error out and the viewer falls back to MJPEG on its own.
   */

  /** Guards every path under /api/camera; returns the go2rtc api base or null after replying. */
  const go2rtcBase = (name: string): string | null =>
    config.proxyableCameras.has(name) && config.frigate ? `${config.frigate.baseUrl}/api/go2rtc/api` : null;

  app.get<{ Params: { name: string } }>('/api/camera/:name/live.m3u8', async (request, reply) => {
    const base = go2rtcBase(request.params.name);
    if (!base) return reply.code(config.frigate ? 404 : 503).send({ error: 'unknown camera or no frigate' });

    try {
      // The master playlist references hls/playlist.m3u8 relatively, which the
      // browser resolves under /api/camera/:name/ - the hls route below.
      const upstream = await fetchWithTimeout(
        `${base}/stream.m3u8?src=${encodeURIComponent(request.params.name)}&mp4`,
        { timeoutMs: 8_000 },
      );
      if (!upstream.ok) return reply.code(502).send({ error: `go2rtc returned ${upstream.status}` });
      return reply
        .header('Content-Type', 'application/vnd.apple.mpegurl')
        .header('Cache-Control', 'no-store')
        .send(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Media playlist, init segment and media segments, named by the master
  // playlist. The id/n query values are go2rtc session state, passed through.
  const HLS_FILES = new Set(['playlist.m3u8', 'init.mp4', 'segment.m4s', 'segment.ts']);

  app.get<{ Params: { name: string; file: string }; Querystring: Record<string, string> }>(
    '/api/camera/:name/hls/:file',
    async (request, reply) => {
      const base = go2rtcBase(request.params.name);
      if (!base) return reply.code(config.frigate ? 404 : 503).send({ error: 'unknown camera or no frigate' });
      if (!HLS_FILES.has(request.params.file)) return reply.code(404).send({ error: 'unknown hls file' });

      const query = new URLSearchParams(request.query).toString();
      try {
        const upstream = await fetchWithTimeout(`${base}/hls/${request.params.file}?${query}`, { timeoutMs: 8_000 });
        if (!upstream.ok) return reply.code(502).send({ error: `go2rtc returned ${upstream.status}` });
        return reply
          .header(
            'Content-Type',
            upstream.headers.get('content-type') ??
              (request.params.file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4'),
          )
          .header('Cache-Control', 'no-store')
          .send(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  app.get<{ Params: { name: string } }>('/api/camera/:name/live.mp4', async (request, reply) => {
    const base = go2rtcBase(request.params.name);
    if (!base) return reply.code(config.frigate ? 404 : 503).send({ error: 'unknown camera or no frigate' });

    // Open-ended like the MJPEG stream: abort upstream the moment the tab goes.
    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());
    const headerTimer = setTimeout(() => controller.abort(), 8_000);

    let upstream: Response;
    try {
      upstream = await fetch(`${base}/stream.mp4?src=${encodeURIComponent(request.params.name)}`, {
        signal: controller.signal,
      });
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(headerTimer);
    }
    if (!upstream.ok || !upstream.body) {
      return reply.code(502).send({ error: `go2rtc returned ${upstream.status}` });
    }

    return reply
      .header('Content-Type', upstream.headers.get('content-type') ?? 'video/mp4')
      .header('Cache-Control', 'no-store')
      .header('X-Accel-Buffering', 'no')
      .send(Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>));
  });
}
