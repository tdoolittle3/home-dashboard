import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { HaClient } from './ha/client.js';
import { MeshClient } from './mesh/client.js';
import { registerAdsbRoutes } from './routes/adsb.js';
import { registerApiRoutes } from './routes/api.js';
import { registerHostRoutes } from './routes/host.js';
import { registerPhotosRoutes } from './routes/photos.js';
import { registerSnibblyRoutes } from './routes/snibbly.js';
import { registerStreamRoute } from './routes/stream.js';
import { SnapshotBuilder } from './snapshot.js';

const here = dirname(fileURLToPath(import.meta.url));

// Served in place of a deleted hashed bundle. The sessionStorage flag stops a reload loop if the reload still
// can't find a bundle (a genuinely broken deploy).
const STALE_BUNDLE_RELOAD =
  "try{if(!sessionStorage.getItem('bundle-reloaded')){sessionStorage.setItem('bundle-reloaded','1');location.reload();}}catch(e){}";

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
  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL']?.trim() || 'info' },
    // Hijacked SSE/MJPEG responses never go idle, so without this app.close() waits on them forever.
    forceCloseConnections: true,
  });

  const ha = new HaClient(config.ha.baseUrl, config.ha.token, (message, extra) => {
    if (extra === undefined) app.log.info(message);
    else app.log.warn({ err: extra }, message);
  });

  const mesh = config.mesh
    ? new MeshClient(config.mesh, (message, extra) => {
        if (extra === undefined) app.log.info(message);
        else app.log.warn({ err: extra }, message);
      })
    : null;

  const snapshots = new SnapshotBuilder(config, ha, mesh);

  registerApiRoutes(app, config, ha, snapshots, mesh);
  registerStreamRoute(app, config, ha, snapshots, mesh);
  registerSnibblyRoutes(app, config);
  registerPhotosRoutes(app, config);
  registerAdsbRoutes(app, config);
  registerHostRoutes(app, config);

  const webDist = resolveWebDist();
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      // Hashed build assets never change, so they cache forever. Everything else (index.html above all) must
      // revalidate, or a phone keeps an old shell pointing at a bundle the last deploy deleted: a blank page.
      setHeaders: (res, filePath) => {
        const hashed = /[\\/]assets[\\/]/.test(filePath);
        res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-store');
      },
    });
    // Client-side routing: anything that is not an API call falls back to the app shell.
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split('?')[0] ?? '';
      const readOnly = request.method === 'GET' || request.method === 'HEAD';
      // A stale cached shell asks for a bundle a deploy removed. A 404 leaves it blank, so answer with a tiny
      // script that reloads once; the reload fetches the fresh index.html (served no-store).
      if (readOnly && path.startsWith('/assets/') && path.endsWith('.js')) {
        return reply
          .code(200)
          .header('Cache-Control', 'no-store')
          .type('application/javascript')
          .send(STALE_BUNDLE_RELOAD);
      }
      // A missing API call or build asset must 404, not come back as HTML a script then fails to parse.
      if (path.startsWith('/api/') || path.startsWith('/assets/') || !readOnly) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.header('Cache-Control', 'no-store').sendFile('index.html');
    });
    app.log.info(`Serving the frontend from ${webDist}`);
  } else {
    app.log.warn('No frontend build found - run "npm run build" (in dev, use the Vite server on :5173)');
  }

  ha.start();
  mesh?.start();
  await app.listen({ port: config.port, host: config.host });

  const shutdown = (signal: string): void => {
    app.log.info(`${signal} received, shutting down`);
    ha.stop();
    mesh?.stop();
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
