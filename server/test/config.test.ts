import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const OWNED_ENV = /^(HA_|FRIGATE_|MESH_|LLAMA_|STT_|HOST_|DOCKER_|DASHBOARD_|PORT$|JELLYFIN_|IMMICH_|ADGUARD_|UPTIME_)/;

let dir: string;
let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dash-config-'));
  saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (OWNED_ENV.test(key)) delete process.env[key];
  }
  process.env['HA_BASE_URL'] = 'http://ha.local:8123/';
  process.env['HA_TOKEN'] = 'token';
});

afterEach(() => {
  process.env = saved;
  rmSync(dir, { recursive: true, force: true });
});

function load(dashboard: unknown) {
  const path = join(dir, 'dashboard.json');
  writeFileSync(path, JSON.stringify(dashboard));
  process.env['DASHBOARD_CONFIG'] = path;
  return loadConfig();
}

describe('loadConfig', () => {
  it('derives the watch, control and camera allowlists from panels', () => {
    const config = load({
      panels: [
        {
          id: 'c',
          title: 'Controls',
          type: 'controls',
          entities: [{ entity_id: 'switch.fan' }],
          lights: { entities: [{ entity_id: 'light.lamp' }] },
          sensors: [{ entity_id: 'binary_sensor.door' }],
        },
        { id: 'e', title: 'Temps', type: 'entities', entities: [{ entity_id: 'sensor.temp' }] },
        { id: 'cam', title: 'Cams', type: 'cameras', cameras: [{ name: 'driveway' }] },
      ],
      outdoor: { temperature: 'sensor.out_t', humidity: 'sensor.out_h' },
    });

    expect([...config.controllableEntities].sort()).toEqual(['light.lamp', 'switch.fan']);
    expect(config.watchedEntities).toEqual(
      expect.arrayContaining([
        'switch.fan',
        'light.lamp',
        'binary_sensor.door',
        'sensor.temp',
        'sensor.out_t',
        'sensor.out_h',
      ]),
    );
    // Read-only sensors and entity rows stream, but must never become writable.
    expect(config.controllableEntities.has('binary_sensor.door')).toBe(false);
    expect(config.controllableEntities.has('sensor.temp')).toBe(false);
    expect([...config.proxyableCameras]).toEqual(['driveway']);
  });

  it('strips trailing slashes and applies defaults', () => {
    const config = load({ panels: [] });
    expect(config.ha.baseUrl).toBe('http://ha.local:8123');
    expect(config.port).toBe(8099);
    expect(config.hostRestart).toBeNull();
    expect(config.mesh).toBeNull();
  });

  it('enables host restart only for exactly HOST_RESTART=1', () => {
    process.env['HOST_RESTART'] = 'true';
    expect(load({ panels: [] }).hostRestart).toBeNull();
    process.env['HOST_RESTART'] = '1';
    expect(load({ panels: [] }).hostRestart).toMatchObject({ socketPath: '/var/run/docker.sock' });
  });

  it('requires HA_TOKEN', () => {
    delete process.env['HA_TOKEN'];
    expect(() => load({ panels: [] })).toThrow(/HA_TOKEN is required/);
  });

  const invalid: [string, unknown, RegExp][] = [
    [
      'duplicate panel ids',
      {
        panels: [
          { id: 'a', title: 'A', type: 'mesh' },
          { id: 'a', title: 'B', type: 'mesh' },
        ],
      },
      /duplicate panel id/,
    ],
    [
      'a malformed entity id',
      { panels: [{ id: 'a', title: 'A', type: 'entities', entities: [{ entity_id: 'Not An Entity' }] }] },
      /invalid entity_id/,
    ],
    [
      'a camera name that is not path-safe',
      { panels: [{ id: 'a', title: 'A', type: 'cameras', cameras: [{ name: '../etc' }] }] },
      /invalid camera name/,
    ],
    ['an unknown panel type', { panels: [{ id: 'a', title: 'A', type: 'nope' }] }, /unknown type/],
    [
      'an adsb baseHost with a path or userinfo',
      { panels: [{ id: 'a', title: 'A', type: 'adsb', baseHost: 'user@evil.com/x' }] },
      /baseHost/,
    ],
    [
      'adsb panels pointing at different receivers',
      {
        panels: [
          { id: 'a', title: 'A', type: 'adsb', baseHost: 'one:8080' },
          { id: 'b', title: 'B', type: 'adsb', baseHost: 'two:8080' },
        ],
      },
      /disagree/,
    ],
    [
      'a non-http link',
      { panels: [], links: [{ label: 'x', url: 'javascript:alert(1)' }] },
      /http\(s\)/,
    ],
    [
      'a system metric with warn above crit',
      {
        panels: [
          {
            id: 'a',
            title: 'A',
            type: 'system',
            metrics: [{ entity_id: 'sensor.cpu', warn: 90, crit: 50 }],
          },
        ],
      },
      /"warn" above "crit"/,
    ],
  ];

  it.each(invalid)('rejects %s', (_name, dashboard, message) => {
    expect(() => load(dashboard)).toThrow(message);
  });

  it('validates the mesh env block', () => {
    process.env['MESH_MQTT_URL'] = 'http://wrong';
    expect(() => load({ panels: [] })).toThrow(/mqtt:\/\//);
    process.env['MESH_MQTT_URL'] = 'mqtt://broker:1883';
    expect(() => load({ panels: [] })).toThrow(/MESH_CHANNEL/);
    process.env['MESH_CHANNEL'] = 'homemesh';
    process.env['MESH_GATEWAY_NODE'] = '12345';
    expect(load({ panels: [] }).mesh).toMatchObject({
      channel: 'homemesh',
      gatewayNode: 12345,
      channelIndex: null,
    });
  });
});
