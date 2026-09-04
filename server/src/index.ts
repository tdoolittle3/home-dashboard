import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { HaClient } from './ha/client.js';
import { registerApiRoutes } from './routes/api.js';
import { registerStreamRoute } from './routes/stream.js';
import { SnapshotBuilder } from './snapshot.js';

const here = dirname(fileURLToPath(import.meta.url));

function resolveWebDist(): string | null {
  const configured = process.env['WEB_DIST']?.trim();
  const candidates = configured ? [configured] : [join(here, '..', '..', 'web', 'dist')];
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (existsSync(join(absolute, 'index.html'))) return absolute;
  }
  return null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = Fastify({ logger: { level: process.env['LOG_LEVEL']?.trim() || 'info' } });

  const ha = new HaClient(config.ha.baseUrl, config.ha.token, (message, extra) => {
    if (extra === undefined) app.log.info(message);
    else app.log.warn({ err: extra }, message);
  });

  const snapshots = new SnapshotBuilder(config, ha);

  registerApiRoutes(app, config, ha, snapshots);
  registerStreamRoute(app, config, ha, snapshots);

  const webDist = resolveWebDist();
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    // Client-side routing: anything that is not an API call falls back to the app shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
    app.log.info(`Serving the frontend from ${webDist}`);
  } else {
    app.log.warn('No frontend build found - run "npm run build" (in dev, use the Vite server on :5173)');
  }

  ha.start();
  await app.listen({ port: config.port, host: config.host });

  const shutdown = (signal: string): void => {
    app.log.info(`${signal} received, shutting down`);
    ha.stop();
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
