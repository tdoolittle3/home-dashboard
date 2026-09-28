import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { HaClient } from '../ha/client.js';
import type { MeshClient } from '../mesh/client.js';
import { toEntitySnapshot, type SnapshotBuilder } from '../snapshot.js';

const HEARTBEAT_MS = 20_000;
/** Mesh telemetry arrives in clumps; coalesce them into one frame. */
const MESH_DEBOUNCE_MS = 250;

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
  mesh: MeshClient | null = null,
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

    // Mesh state is event-driven like `state`, not polled like `sources` - a
    // chat message should not wait for the 15s source push. The whole summary
    // is small, so each frame replaces the slice wholesale.
    let meshTimer: NodeJS.Timeout | null = null;
    const offMesh = mesh
      ? mesh.addListener(() => {
          meshTimer ??= setTimeout(() => {
            meshTimer = null;
            send('mesh', mesh.summary());
          }, MESH_DEBOUNCE_MS);
        })
      : null;

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
      offMesh?.();
      if (meshTimer) clearTimeout(meshTimer);
      clearInterval(sourceTimer);
      clearInterval(heartbeat);
      response.end();
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
