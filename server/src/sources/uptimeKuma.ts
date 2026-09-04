import { getText } from './http.js';

export interface KumaMonitor {
  name: string;
  type: string | null;
  status: 'up' | 'down' | 'pending' | 'maintenance' | 'unknown';
  responseTimeMs: number | null;
  certDaysRemaining: number | null;
}

export interface KumaSummary {
  monitors: KumaMonitor[];
  up: number;
  down: number;
}

/**
 * Uptime Kuma has no documented REST API - its own UI talks socket.io. The one
 * pull-based surface is the Prometheus exporter at /metrics, authenticated with
 * an API key as the HTTP basic password (empty username).
 *
 * UNVERIFIED against the Kuma instance on 192.168.0.13:3001. If this returns
 * 401/404, check Settings -> API Keys is populated and that /metrics is enabled
 * on that version before assuming the parser is at fault. Kuma also has no
 * monitors configured yet, so an empty list is the expected result today.
 */
const STATUS_BY_CODE: Record<string, KumaMonitor['status']> = {
  '0': 'down',
  '1': 'up',
  '2': 'pending',
  '3': 'maintenance',
};

/** Parses `metric_name{label="value",...} 1.23` lines, ignoring comments. */
function parseMetrics(body: string): { name: string; labels: Record<string, string>; value: number }[] {
  const samples: { name: string; labels: Record<string, string>; value: number }[] = [];

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const [, name, labelBlob, rawValue] = match;
    if (!name) continue;

    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;

    const labels: Record<string, string> = {};
    if (labelBlob) {
      // Values may contain commas (URLs, user agents), so match pairs rather than splitting.
      for (const pair of labelBlob.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
        const key = pair[1];
        const raw = pair[2];
        if (key !== undefined && raw !== undefined) labels[key] = raw.replace(/\\(.)/g, '$1');
      }
    }

    samples.push({ name, labels, value });
  }

  return samples;
}

export function createUptimeKumaSource(baseUrl: string, apiKey: string) {
  const auth = Buffer.from(`:${apiKey}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };

  return async function fetchUptimeKuma(): Promise<KumaSummary> {
    const body = await getText(`${baseUrl}/metrics`, { headers });
    const samples = parseMetrics(body);

    const monitors = new Map<string, KumaMonitor>();
    const ensure = (labels: Record<string, string>): KumaMonitor | null => {
      const name = labels['monitor_name'];
      if (!name) return null;
      let monitor = monitors.get(name);
      if (!monitor) {
        monitor = {
          name,
          type: labels['monitor_type'] ?? null,
          status: 'unknown',
          responseTimeMs: null,
          certDaysRemaining: null,
        };
        monitors.set(name, monitor);
      }
      return monitor;
    };

    for (const sample of samples) {
      const monitor = ensure(sample.labels);
      if (!monitor) continue;

      if (sample.name === 'monitor_status') {
        monitor.status = STATUS_BY_CODE[String(sample.value)] ?? 'unknown';
      } else if (sample.name === 'monitor_response_time') {
        monitor.responseTimeMs = sample.value;
      } else if (sample.name === 'monitor_cert_days_remaining') {
        monitor.certDaysRemaining = sample.value;
      }
    }

    const list = [...monitors.values()].sort((a, b) => a.name.localeCompare(b.name));
    return {
      monitors: list,
      up: list.filter((monitor) => monitor.status === 'up').length,
      down: list.filter((monitor) => monitor.status === 'down').length,
    };
  };
}
