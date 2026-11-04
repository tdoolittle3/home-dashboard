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

/** An image pull can take a while on a slow link; every other call is quick. */
const DOCKER_PULL_TIMEOUT_MS = 180_000;

/** A single JSON call to the Docker Engine API over its unix socket. */
function dockerCall(
  socketPath: string,
  path: string,
  payload?: unknown,
  opts: { method?: 'GET' | 'POST' | 'DELETE'; timeoutMs?: number } = {},
): Promise<DockerReply> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const req = httpRequest(
      {
        socketPath,
        path,
        method: opts.method ?? 'POST',
        timeout: opts.timeoutMs ?? 10_000,
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

  /** create never pulls, so a host that has not run this image yet would 404 on first use. */
  const ensureImage = async (): Promise<void> => {
    const image = encodeURIComponent(restart.image);
    const found = await dockerCall(restart.socketPath, `/images/${restart.image}/json`, undefined, { method: 'GET' });
    if (found.status === 200) return;
    if (found.status !== 404) throw new Error(`docker image inspect ${found.status}: ${found.body.slice(0, 200)}`);

    // The pull streams progress as 200 even when it fails midway, so re-inspect to confirm.
    await dockerCall(restart.socketPath, `/images/create?fromImage=${image}`, undefined, {
      timeoutMs: DOCKER_PULL_TIMEOUT_MS,
    });
    const after = await dockerCall(restart.socketPath, `/images/${restart.image}/json`, undefined, { method: 'GET' });
    if (after.status !== 200) throw new Error(`could not pull ${restart.image} (inspect ${after.status})`);
  };

  app.post('/api/host/restart', async (request, reply) => {
    const body = request.body;
    const confirmed =
      typeof body === 'object' && body !== null && (body as { confirm?: unknown }).confirm === 'restart';
    if (!confirmed) return reply.code(400).send({ error: 'send {"confirm":"restart"} to restart the host' });

    // Claim the cooldown BEFORE the first await: the checks below yield, so a
    // double tap would otherwise get past the guard twice. A failure releases it.
    const now = Date.now();
    if (now - lastRestartAt < RESTART_COOLDOWN_MS) {
      return reply.code(429).send({ error: 'a restart was just requested' });
    }
    const previousRestartAt = lastRestartAt;
    lastRestartAt = now;

    let createdId: string | null = null;
    try {
      await ensureImage();

      const created = await dockerCall(restart.socketPath, '/containers/create', {
        Image: restart.image,
        Cmd: REBOOT_CMD,
        HostConfig: { Privileged: true, PidMode: 'host', AutoRemove: true },
      });
      if (created.status !== 201) throw new Error(`docker create ${created.status}: ${created.body.slice(0, 200)}`);

      const id = (JSON.parse(created.body) as { Id?: string }).Id;
      if (!id) throw new Error('docker create returned no container id');
      createdId = id;

      const started = await dockerCall(restart.socketPath, `/containers/${id}/start`);
      if (started.status !== 204) throw new Error(`docker start ${started.status}: ${started.body.slice(0, 200)}`);
    } catch (error) {
      lastRestartAt = previousRestartAt;
      // AutoRemove only fires once the container has run; one that never started stays behind.
      if (createdId) {
        await dockerCall(restart.socketPath, `/containers/${createdId}?force=true`, undefined, {
          method: 'DELETE',
        }).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : String(error);
      request.log.error({ err: message }, 'host restart failed');
      return reply.code(502).send({ error: message });
    }

    request.log.warn('host restart requested');
    return reply.code(202).send({ accepted: true });
  });
}
