import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLinkHealthSource } from '../src/sources/linkHealth.js';

let server: Server | null = null;

function listen(statusCode: number): Promise<number> {
  server = createServer((_req, res) => {
    res.statusCode = statusCode;
    res.end();
  });
  return new Promise((resolve) => {
    (server as Server).listen(0, '127.0.0.1', () => resolve(((server as Server).address() as AddressInfo).port));
  });
}

afterEach(() => {
  server?.close();
  server = null;
});

describe('createLinkHealthSource', () => {
  it('reports an answering service up, with status and latency', async () => {
    const port = await listen(401);
    const source = createLinkHealthSource([
      { label: 'x', url: 'http://x.ts.net', health: `http://127.0.0.1:${port}/` },
    ]);
    const [result] = await source();
    expect(result).toMatchObject({ label: 'x', up: true, status: 401, error: null });
    expect(result?.latencyMs).not.toBeNull();
  });

  it('reports a gateway answer down - the proxy covering for a dead backend', async () => {
    const port = await listen(502);
    const source = createLinkHealthSource([
      { label: 'x', url: 'http://x.ts.net', health: `http://127.0.0.1:${port}/` },
    ]);
    const [result] = await source();
    expect(result).toMatchObject({ label: 'x', up: false, status: 502, error: 'HTTP 502 from the proxy' });
  });

  it('dials the pinned address instead of resolving the health hostname', async () => {
    const port = await listen(200);
    // A name that must not resolve: only the resolve pin can make this reachable.
    const source = createLinkHealthSource([
      {
        label: 'x',
        url: 'https://x.ts.net',
        health: `http://pinned.invalid:${port}/`,
        resolve: '127.0.0.1',
      },
    ]);
    const [result] = await source();
    expect(result).toMatchObject({ label: 'x', up: true, status: 200 });
  });

  it('reports a refused connection down with the error', async () => {
    const port = await listen(200);
    const gone = port; // reuse the port after closing so nothing listens there
    await new Promise((resolve) => server?.close(resolve));
    server = null;
    const source = createLinkHealthSource([
      { label: 'x', url: 'http://x.ts.net', health: `http://127.0.0.1:${gone}/` },
    ]);
    const [result] = await source();
    expect(result).toMatchObject({ label: 'x', up: false, status: null });
    expect(result?.error).toBeTruthy();
  });
});
