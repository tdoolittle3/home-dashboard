// A stand-in Home Assistant, just enough for the dashboard: the WebSocket auth
// handshake, get_states, subscribe_events (acknowledged, never fired) and the
// REST history endpoint the voltage sparkline reads. Use it to preview panel
// states - above all the UPS panel's warning/critical looks - without touching
// the real UPS or HA.
//
//   node scripts/mock-ha.mjs [ok|warning|critical|unavailable|absent] [port]
//   HA_BASE_URL=http://127.0.0.1:18123 HA_TOKEN=mock npm start
//
// Any token is accepted. `unavailable` reports the UPS entities with state
// "unavailable" (MQTT integration down); `absent` omits them entirely (HA
// restarted, discovery not yet replayed).
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const scenario = process.argv[2] ?? 'ok';
const port = Number(process.argv[3] ?? 18123);

const now = () => new Date().toISOString();
const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

function entity(entityId, state, attributes = {}, changedSecondsAgo = 25) {
  return {
    entity_id: entityId,
    state: String(state),
    attributes,
    last_changed: ago(changedSecondsAgo),
    last_updated: ago(changedSecondsAgo),
  };
}

/** The five ups-guard discovery entities for one scenario. */
function upsEntities() {
  const sensor = (key, name, value, unit, extra = {}) =>
    entity(`sensor.ladybird_ups_${key}`, value, {
      friendly_name: `Ladybird UPS ${name}`,
      unit_of_measurement: unit,
      state_class: 'measurement',
      ...extra,
    });

  const problem = (on, attrs) =>
    entity('binary_sensor.ladybird_ups_power_problem', on ? 'on' : 'off', {
      friendly_name: 'Ladybird UPS Power Problem',
      device_class: 'problem',
      ...attrs,
    });

  switch (scenario) {
    case 'ok':
      return [
        sensor('battery_charge', 'Battery Charge', 100, '%', { device_class: 'battery' }),
        sensor('battery_runtime', 'Battery Runtime', 46, 'min', { device_class: 'duration' }),
        sensor('ups_load', 'UPS Load', 18, '%'),
        sensor('input_voltage', 'Input Voltage', 121.5, 'V', { device_class: 'voltage' }),
        problem(false, {
          battery_charge: 100,
          runtime_min: 46,
          load_pct: 18,
          input_voltage: 121.5,
          ups_status: 'OL',
          status: 'ok',
          reason: 'on line power, battery 100%',
        }),
      ];
    case 'warning':
      return [
        sensor('battery_charge', 'Battery Charge', 74, '%', { device_class: 'battery' }),
        sensor('battery_runtime', 'Battery Runtime', 31, 'min', { device_class: 'duration' }),
        sensor('ups_load', 'UPS Load', 21, '%'),
        sensor('input_voltage', 'Input Voltage', 118.9, 'V', { device_class: 'voltage' }),
        problem(true, {
          battery_charge: 74,
          runtime_min: 31,
          load_pct: 21,
          input_voltage: 118.9,
          ups_status: 'OL CHRG',
          status: 'warning',
          reason: 'charge 74% < 80% on line power',
        }),
      ];
    case 'critical':
      return [
        sensor('battery_charge', 'Battery Charge', 64, '%', { device_class: 'battery' }),
        sensor('battery_runtime', 'Battery Runtime', 127, 'min', { device_class: 'duration' }),
        sensor('ups_load', 'UPS Load', 22, '%'),
        sensor('input_voltage', 'Input Voltage', 0, 'V', { device_class: 'voltage' }),
        problem(true, {
          battery_charge: 64,
          runtime_min: 127,
          load_pct: 22,
          input_voltage: 0,
          ups_status: 'OB DISCHRG',
          status: 'critical',
          reason: 'on battery - utility power lost',
        }),
      ];
    case 'unavailable':
      return [
        sensor('battery_charge', 'Battery Charge', 'unavailable', '%'),
        sensor('battery_runtime', 'Battery Runtime', 'unavailable', 'min'),
        sensor('ups_load', 'UPS Load', 'unavailable', '%'),
        sensor('input_voltage', 'Input Voltage', 'unavailable', 'V'),
        entity(
          'binary_sensor.ladybird_ups_power_problem',
          'unavailable',
          { friendly_name: 'Ladybird UPS Power Problem', device_class: 'problem' },
          1_380,
        ),
      ];
    case 'absent':
      return [];
    default:
      console.error(`unknown scenario "${scenario}" - use ok|warning|critical|unavailable|absent`);
      process.exit(1);
  }
}

/** Plausible readings for the rest of the dashboard, so a preview looks lived-in. */
function hostEntities() {
  const pct = (id, name, value) =>
    entity(`sensor.${id}`, value, { friendly_name: name, unit_of_measurement: '%' });
  const val = (id, name, value, unit) =>
    entity(`sensor.${id}`, value, { friendly_name: name, unit_of_measurement: unit });

  return [
    entity('sensor.system_monitor_last_boot', new Date(Date.now() - 19 * 86_400_000).toISOString(), {
      friendly_name: 'Last boot',
      device_class: 'timestamp',
    }),
    pct('system_monitor_processor_use', 'Processor use', 7),
    pct('system_monitor_memory_usage', 'Memory usage', 41),
    pct('system_monitor_swap_usage', 'Swap usage', 2),
    val('system_monitor_processor_temperature', 'Processor temperature', 118, '°F'),
    val('ladybird_storage_nvme_temperature', 'NVMe temperature', 104, '°F'),
    val('system_monitor_load_1_min', 'Load (1m)', 0.8, ''),
    val('system_monitor_network_throughput_in_enp44s0', 'Network in', 1.4, 'MB/s'),
    val('system_monitor_network_throughput_out_enp44s0', 'Network out', 0.3, 'MB/s'),
    entity('binary_sensor.ladybird_storage_storage_problem', 'off', {
      friendly_name: 'Storage problem',
      device_class: 'problem',
    }),
    pct('ladybird_storage_disk_used', 'Disk used', 62),
    val('ladybird_storage_disk_free', 'Disk free', 312, 'GB'),
    val('ladybird_storage_frigate_recordings', 'Frigate recordings', 214, 'GB'),
    val('ladybird_storage_media_library', 'Media library', 187, 'GB'),
    entity('switch.frontcam_white_light', 'off', { friendly_name: 'Driveway white light' }),
  ];
}

/**
 * 24h of input voltage: steady ~121 V with mains wobble, one afternoon
 * brownout, and - in the critical scenario - the ongoing outage at 0 V.
 */
function voltageHistory() {
  const points = [];
  const start = Date.now() - 24 * 3_600_000;
  for (let minute = 0; minute <= 24 * 60; minute += 5) {
    const t = start + minute * 60_000;
    let v = 121 + Math.sin(minute / 47) * 0.9 + Math.sin(minute / 13) * 0.4;
    if (minute >= 15 * 60 && minute < 15 * 60 + 20) v = 104.2; // brownout
    if (scenario === 'critical' && minute >= 24 * 60 - 25) v = 0; // the outage
    points.push({ state: v.toFixed(1), last_changed: new Date(t).toISOString() });
  }
  return points;
}

const states = [...hostEntities(), ...upsEntities()];

const http = createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/history/period')) {
    const entityId = url.searchParams.get('filter_entity_id') ?? '';
    const rows = entityId.includes('input_voltage') ? voltageHistory() : [];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify([rows.map((row, i) => (i === 0 ? { ...row, entity_id: entityId } : row))]));
    return;
  }
  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'mock-ha only serves /api/websocket and /api/history' }));
});

const wss = new WebSocketServer({ server: http, path: '/api/websocket' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2025.8.0' }));
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'auth') {
      ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2025.8.0' }));
      return;
    }
    if (message.type === 'ping') {
      ws.send(JSON.stringify({ id: message.id, type: 'pong' }));
      return;
    }
    if (message.type === 'get_states') {
      ws.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: states }));
      return;
    }
    // subscribe_events and anything else: acknowledge and stay silent.
    ws.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: null }));
  });
});

http.listen(port, '127.0.0.1', () => {
  console.log(`mock-ha [${scenario}] listening on http://127.0.0.1:${port} (${states.length} entities, ${now()})`);
});
