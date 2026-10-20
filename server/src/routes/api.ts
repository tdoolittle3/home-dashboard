import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { HaClient } from '../ha/client.js';
import type { MeshClient } from '../mesh/client.js';
import type { SnapshotBuilder } from '../snapshot.js';
import { fetchWithTimeout, getJson } from '../sources/http.js';

const ACTIONS = new Set(['turn_on', 'turn_off', 'toggle']);

/** A LoRa text payload tops out around 230 bytes; stop short of it. */
const MESH_TEXT_MAX_BYTES = 200;
/** One message per this many ms - LoRa airtime is a shared resource. */
const MESH_SEND_COOLDOWN_MS = 2_000;

/** One recorded state in HA's REST history reply, trimmed by minimal_response. */
interface HistoryRow {
  state?: string;
  last_changed?: string;
  /** Compact key some HA versions use for last_updated, epoch seconds. */
  lu?: number;
}

/** A day of context by default; two at most - this backs a sparkline, not Grafana. */
function clampHours(raw: string | undefined): number {
  const requested = Number(raw);
  return Number.isFinite(requested) ? Math.min(Math.max(Math.round(requested), 1), 48) : 24;
}

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
  mesh: MeshClient | null = null,
): void {
  app.get('/api/health', async () => ({
    ok: true,
    ha: ha.status,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/api/dashboard', async () => snapshots.build());

  /**
   * Recent numeric history for one dashboard entity, for sparklines. This is
   * the only place the server calls HA's REST API - state itself rides the
   * WebSocket. Restricted to watched entities so the token's reach into the
   * recorder never exceeds what the dashboard already shows.
   */
  const watched = new Set(config.watchedEntities);
  app.get<{ Params: { entityId: string }; Querystring: { hours?: string } }>(
    '/api/history/:entityId',
    async (request, reply) => {
      const { entityId } = request.params;
      if (!watched.has(entityId)) {
        return reply.code(404).send({ error: 'entity is not on the dashboard' });
      }

      const hours = clampHours(request.query.hours);
      const end = new Date();
      const start = new Date(end.getTime() - hours * 3_600_000);
      const query = new URLSearchParams({
        filter_entity_id: entityId,
        end_time: end.toISOString(),
        minimal_response: '',
        no_attributes: '',
      });

      try {
        const rows = await getJson<HistoryRow[][]>(
          `${config.ha.baseUrl}/api/history/period/${start.toISOString()}?${query}`,
          { headers: { Authorization: `Bearer ${config.ha.token}` }, timeoutMs: 8_000 },
        );
        const points = (rows[0] ?? []).flatMap((row) => {
          const value = Number(row.state);
          const time = row.last_changed ? Date.parse(row.last_changed) : (row.lu ?? 0) * 1000;
          return Number.isFinite(value) && time > 0 ? [{ t: time, v: value }] : [];
        });
        return { entity_id: entityId, points };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(502).send({ error: message });
      }
    },
  );

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
   * The mesh write path, gated the same way as /api/action: the feature only
   * works when it was deliberately configured - a `mesh` panel in
   * dashboard.json is the allowlist, and the send env vars are the credential.
   */
  const meshPanelConfigured = config.dashboard.panels.some((panel) => panel.type === 'mesh');
  let meshLastSendAt = 0;

  app.post('/api/mesh/send', async (request, reply) => {
    if (!mesh || !meshPanelConfigured) {
      return reply.code(403).send({ error: 'mesh send is not enabled on this dashboard' });
    }

    const body = (request.body ?? {}) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length === 0) {
      return reply.code(400).send({ error: 'text must be a non-empty string' });
    }
    if (Buffer.byteLength(text, 'utf8') > MESH_TEXT_MAX_BYTES) {
      return reply.code(400).send({ error: `text must fit in ${MESH_TEXT_MAX_BYTES} bytes` });
    }
    if (!mesh.canSend) {
      // Either the broker is down or MESH_GATEWAY_NODE / MESH_CHANNEL_INDEX
      // are unset (read-only mode); the status pill already says which.
      return reply.code(503).send({ error: 'mesh send is not available right now' });
    }
    const now = Date.now();
    if (now - meshLastSendAt < MESH_SEND_COOLDOWN_MS) {
      return reply.code(429).send({ error: 'sending too fast - LoRa airtime is shared' });
    }

    try {
      mesh.send(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ error: message });
    }
    meshLastSendAt = now;

    // The echoed message arrives over the `mesh` stream event; do not guess here.
    return reply.code(202).send({ accepted: true });
  });

  /**
   * The assistant chat: relays one conversation turn to llama-swap on the
   * inference box and streams the completion back as the same SSE the browser
   * would get from llama-swap directly - except the API key stays server-side,
   * like every other credential here. The model comes from dashboard.json's
   * "assistant", so pointing the button at a different model (or a future
   * agent harness) is a config change, not a code change.
   */
  const CHAT_ROLES = new Set(['user', 'assistant']);
  const CHAT_MAX_MESSAGES = 40;
  const CHAT_MAX_CHARS = 8_000;
  /** Selecting a cold model makes llama-swap swap it in before the first token; its own ceiling is healthCheckTimeout (minutes, not seconds). */
  const CHAT_TIMEOUT_MS = 300_000;
  // No /no_think here: the abliterated model ignores the soft switch anyway,
  // and the modal shows the reasoning live then drops it when the answer starts.
  const CHAT_SYSTEM_PROMPT = 'You are the assistant on the ladybird home dashboard. Be concise, direct and helpful.';

  app.post('/api/chat', async (request, reply) => {
    const llamaSwap = config.llamaSwap;
    const assistant = config.dashboard.assistant;
    if (!llamaSwap || !assistant) {
      return reply.code(503).send({ error: 'assistant is not configured' });
    }

    const body = (request.body ?? {}) as { messages?: unknown };
    const raw = Array.isArray(body.messages) ? body.messages : null;
    if (!raw || raw.length === 0 || raw.length > CHAT_MAX_MESSAGES) {
      return reply.code(400).send({ error: `messages must be an array of 1-${CHAT_MAX_MESSAGES}` });
    }
    const messages: { role: string; content: string }[] = [];
    for (const entry of raw) {
      const message = entry as { role?: unknown; content?: unknown };
      if (
        typeof message.role !== 'string' ||
        !CHAT_ROLES.has(message.role) ||
        typeof message.content !== 'string' ||
        message.content.length === 0 ||
        message.content.length > CHAT_MAX_CHARS
      ) {
        return reply
          .code(400)
          .send({ error: `each message needs a user/assistant role and 1-${CHAT_MAX_CHARS} chars of content` });
      }
      messages.push({ role: message.role, content: message.content });
    }

    // The disconnect signal lives on the RESPONSE here: on a POST, request.raw
    // emits 'close' as soon as the consumed body stream is torn down - long
    // before the client goes anywhere. reply.raw closes when the client does
    // (or when the reply finishes, when aborting is a no-op).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    reply.raw.on('close', () => {
      clearTimeout(timer);
      controller.abort();
    });

    let upstream: Response;
    try {
      upstream = await fetch(`${llamaSwap.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${llamaSwap.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: assistant.model,
          messages: [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, ...messages],
          stream: true,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return reply
        .code(502)
        .send({ error: `llama-swap returned ${upstream.status}${detail ? `: ${detail.slice(0, 300)}` : ''}` });
    }

    return reply
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-store')
      .header('X-Accel-Buffering', 'no')
      .send(Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>));
  });

  /**
   * The mic button's other half: the browser records a clip (webm on Chrome,
   * mp4 on iPhone - whisper's bundled ffmpeg takes either) and posts it here
   * raw; this relays it to whisper.cpp on the LAN and answers with the
   * transcript. A spoken command runs seconds, so the cap is generous.
   */
  const STT_MAX_BYTES = 15 * 1024 * 1024;
  const STT_TIMEOUT_MS = 60_000;
  const STT_EXT: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
  };

  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: STT_MAX_BYTES }, (_request, body, done) =>
    done(null, body),
  );

  app.post<{ Querystring: { seconds?: string } }>('/api/stt', async (request, reply) => {
    const stt = config.stt;
    if (!stt) {
      return reply.code(503).send({ error: 'STT_BASE_URL is not configured' });
    }
    const audio = request.body;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      return reply.code(400).send({ error: 'post the recorded audio as the raw body with its audio/* content type' });
    }

    const mime = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), `clip.${STT_EXT[mime] ?? 'webm'}`);
    form.append('response_format', 'json');

    // The mic overlay's interim passes say how long the still-growing clip is.
    // whisper pads everything to a 30s encoder window, so a 1s clip costs as
    // much as a 30s one (~2.4s on the 6 ladybird threads); fitting the window
    // to the clip (50 ctx units per second, plus margin) brings a pass under
    // a second. Fallback retries are disabled too - on mostly-silent partials
    // they burn seconds hallucinating. The final pass sends no `seconds` and
    // keeps whisper's full-quality defaults.
    const seconds = Number(request.query.seconds);
    if (Number.isFinite(seconds) && seconds > 0 && seconds < 30) {
      form.append('audio_ctx', String(Math.min(1500, Math.round(seconds * 50) + 100)));
      form.append('temperature_inc', '0');
    }

    // fetchWithTimeout only carries headers; this needs a method and a body.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);
    try {
      const upstream = await fetch(`${stt.baseUrl}/inference`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        return reply
          .code(502)
          .send({ error: `whisper returned ${upstream.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` });
      }
      const result = (await upstream.json()) as { text?: unknown };
      const text = typeof result.text === 'string' ? result.text.trim() : '';
      return reply.header('Cache-Control', 'no-store').send({ text });
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
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
   * Detection clips and snapshots, proxied for the same reason as the stills.
   * The clip is buffered so byte-range requests can be answered here: Frigate's
   * nginx streams clips chunked with no range support, and iPhone Safari will
   * not play an MP4 from a server that cannot serve ranges.
   */
  const EVENT_ID = /^[\w.-]+$/;

  /**
   * Guards both event media routes; null means the reply was already sent.
   * The event is looked up first so only cameras the dashboard already shows
   * are served - the same boundary proxyableCameras draws for the stills.
   */
  const eventBase = async (
    id: string,
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ): Promise<string | null> => {
    if (!config.frigate) {
      reply.code(503).send({ error: 'FRIGATE_BASE_URL is not configured' });
      return null;
    }
    if (!EVENT_ID.test(id)) {
      reply.code(404).send({ error: 'unknown event' });
      return null;
    }
    const base = `${config.frigate.baseUrl}/api/events/${encodeURIComponent(id)}`;
    try {
      const event = await getJson<{ camera?: unknown }>(base, { timeoutMs: 8_000 });
      if (typeof event.camera === 'string' && config.proxyableCameras.has(event.camera)) return base;
    } catch {
      // Expired or never existed - same answer either way.
    }
    reply.code(404).send({ error: 'unknown event' });
    return null;
  };

  app.get<{ Params: { id: string } }>('/api/events/:id/snapshot.jpg', async (request, reply) => {
    const base = await eventBase(request.params.id, reply);
    if (!base) return;

    try {
      const upstream = await fetchWithTimeout(`${base}/snapshot.jpg`, { timeoutMs: 8_000 });
      if (!upstream.ok) {
        return reply.code(502).send({ error: `frigate returned ${upstream.status}` });
      }
      return reply
        .header('Content-Type', upstream.headers.get('content-type') ?? 'image/jpeg')
        .header('Cache-Control', 'no-store')
        .send(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string } }>('/api/events/:id/clip.mp4', async (request, reply) => {
    const base = await eventBase(request.params.id, reply);
    if (!base) return;

    let clip: Buffer;
    try {
      // Event clips run seconds, not minutes; whole-clip buffering stays small
      // and is what makes the range handling below possible.
      const upstream = await fetchWithTimeout(`${base}/clip.mp4`, { timeoutMs: 30_000 });
      if (!upstream.ok) {
        return reply.code(502).send({ error: `frigate returned ${upstream.status}` });
      }
      clip = Buffer.from(await upstream.arrayBuffer());
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }

    reply.header('Content-Type', 'video/mp4').header('Cache-Control', 'no-store').header('Accept-Ranges', 'bytes');

    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    if (match && (match[1] || match[2])) {
      // bytes=a-b and bytes=a- read from a; bytes=-n is the final n bytes.
      const start = match[1] ? Number(match[1]) : Math.max(0, clip.length - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), clip.length - 1) : clip.length - 1;
      if (start >= clip.length || start > end) {
        return reply.code(416).header('Content-Range', `bytes */${clip.length}`).send();
      }
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${clip.length}`)
        .send(clip.subarray(start, end + 1));
    }
    return reply.send(clip);
  });

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
