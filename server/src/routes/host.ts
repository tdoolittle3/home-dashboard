import { request as httpRequest } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

/** One reboot per this long - a double tap or a retry must not queue a second one. */
const RESTART_COOLDOWN_MS = 60_000;

/** Joins the host's namespaces and asks systemd to reboot it. */
const REBOOT_CMD = ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'systemctl', 'reboot'];

interface DockerReply {
  status: number;
  body: string;
}

/** A single JSON call to the Docker Engine API over its unix socket. */
function dockerCall(socketPath: string, path: string, payload?: unknown): Promise<DockerReply> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const req = httpRequest(
      {
        socketPath,
        path,
        method: 'POST',
        timeout: 10_000,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : { 'Content-Length': 0 },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('docker socket timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * POST /api/host/restart - reboots the machine the dashboard runs on.
 *
 * A container cannot reboot its host, so this asks the Docker daemon (socket
 * mounted in) for a one-shot privileged container in the host PID namespace
 * that runs systemctl reboot. That is root on the box, which is why the route
 * exists only with HOST_RESTART=1 and demands a body of {"confirm":"restart"}:
 * a parsed JSON object cannot be produced by a cross-site simple request, so a
 * stray page cannot trigger it.
 */
export function registerHostRoutes(app: FastifyInstance, config: AppConfig): void {
  const restart = config.hostRestart;
  if (!restart) return;

  let lastRestartAt = 0;

  app.post('/api/host/restart', async (request, reply) => {
    const body = request.body;
    const confirmed =
      typeof body === 'object' && body !== null && (body as { confirm?: unknown }).confirm === 'restart';
    if (!confirmed) return reply.code(400).send({ error: 'send {"confirm":"restart"} to restart the host' });

    if (Date.now() - lastRestartAt < RESTART_COOLDOWN_MS) {
      return reply.code(429).send({ error: 'a restart was just requested' });
    }

    try {
      const created = await dockerCall(restart.socketPath, '/containers/create', {
        Image: restart.image,
        Cmd: REBOOT_CMD,
        HostConfig: { Privileged: true, PidMode: 'host', AutoRemove: true },
      });
      if (created.status !== 201) throw new Error(`docker create ${created.status}: ${created.body.slice(0, 200)}`);

      const id = (JSON.parse(created.body) as { Id?: string }).Id;
      if (!id) throw new Error('docker create returned no container id');

      const started = await dockerCall(restart.socketPath, `/containers/${id}/start`);
      if (started.status !== 204) throw new Error(`docker start ${started.status}: ${started.body.slice(0, 200)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.log.error({ err: message }, 'host restart failed');
      return reply.code(502).send({ error: message });
    }

    lastRestartAt = Date.now();
    request.log.warn('host restart requested');
    return reply.code(202).send({ accepted: true });
  });
}
