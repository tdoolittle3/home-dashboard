import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { HaClient } from '../ha/client.js';
import type { SnapshotBuilder } from '../snapshot.js';
import { fetchWithTimeout } from '../sources/http.js';

const ACTIONS = new Set(['turn_on', 'turn_off', 'toggle']);

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

      const requested = Number(request.query.h);
      const height = Number.isFinite(requested) ? Math.min(Math.max(Math.round(requested), 90), 1080) : 360;

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
}
