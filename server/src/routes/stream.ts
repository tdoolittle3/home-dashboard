import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { HaClient } from '../ha/client.js';
import { toEntitySnapshot, type SnapshotBuilder } from '../snapshot.js';

const HEARTBEAT_MS = 20_000;

/**
 * Server-sent events rather than a WebSocket: the payload only ever flows
 * server -> browser, and EventSource reconnects on its own. One HA subscription
 * fans out to every open tab.
 */
export function registerStreamRoute(
  app: FastifyInstance,
  config: AppConfig,
  ha: HaClient,
  snapshots: SnapshotBuilder,
): void {
  const watched = new Set(config.watchedEntities);

  app.get('/api/stream', (request, reply) => {
    reply.hijack();
    const response = reply.raw;

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops a reverse proxy from buffering the stream into uselessness.
      'X-Accel-Buffering': 'no',
    });

    let open = true;
    const send = (event: string, payload: unknown): void => {
      if (!open) return;
      response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    void snapshots.build().then((snapshot) => send('snapshot', snapshot));

    const offState = ha.addStateListener((entityId, state) => {
      if (!watched.has(entityId)) return;
      send('state', toEntitySnapshot(entityId, state));
    });

    const offStatus = ha.addStatusListener((status) => send('ha', status));

    const sourceTimer = setInterval(() => {
      void snapshots.sources().then((sources) => send('sources', sources));
    }, config.sourcePushMs);

    const heartbeat = setInterval(() => {
      if (open) response.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);

    const cleanup = (): void => {
      if (!open) return;
      open = false;
      offState();
      offStatus();
      clearInterval(sourceTimer);
      clearInterval(heartbeat);
      response.end();
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
