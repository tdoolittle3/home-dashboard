import { getText } from './http.js';

export interface KumaMonitor {
  name: string;
  type: string | null;
  /** What the monitor watches: a URL, or host:port, whichever Kuma labels it with. */
  target: string | null;
  status: 'up' | 'down' | 'pending' | 'maintenance' | 'unknown';
  responseTimeMs: number | null;
  certDaysRemaining: number | null;
}

export interface KumaSummary {
  monitors: KumaMonitor[];
  up: number;
  down: number;
  pending: number;
  maintenance: number;
}

/**
 * Uptime Kuma has no documented REST API - its own UI talks socket.io. The one
 * pull-based surface is the Prometheus exporter at /metrics, authenticated with
 * an API key (Settings -> API Keys) as the HTTP basic password; Kuma ignores the
 * username. Confirmed on the 1.x instance at 192.168.0.13:3001: /metrics answers
 * 401 without credentials, so the endpoint is there and only the key is missing.
 * Kuma has no monitors configured yet, so an empty list is the expected result
 * until some are added.
 */
const STATUS_BY_CODE: Record<string, KumaMonitor['status']> = {
  '0': 'down',
  '1': 'up',
  '2': 'pending',
  '3': 'maintenance',
};

/** Kuma writes the literal string "null" into labels it has no value for. */
function label(labels: Record<string, string>, key: string): string | null {
  const value = labels[key];
  return value && value !== 'null' ? value : null;
}

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
      const name = label(labels, 'monitor_name');
      if (!name) return null;
      let monitor = monitors.get(name);
      if (!monitor) {
        const hostname = label(labels, 'monitor_hostname');
        const port = label(labels, 'monitor_port');
        monitor = {
          name,
          type: label(labels, 'monitor_type'),
          target: label(labels, 'monitor_url') ?? (hostname ? (port ? `${hostname}:${port}` : hostname) : null),
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
        // Group monitors and anything that has not been checked report -1 for "no figure".
        monitor.responseTimeMs = sample.value >= 0 ? sample.value : null;
      } else if (sample.name === 'monitor_cert_days_remaining') {
        monitor.certDaysRemaining = sample.value >= 0 ? sample.value : null;
      }
    }

    const list = [...monitors.values()].sort((a, b) => a.name.localeCompare(b.name));
    const count = (status: KumaMonitor['status']): number =>
      list.filter((monitor) => monitor.status === status).length;

    return {
      monitors: list,
      up: count('up'),
      down: count('down'),
      pending: count('pending'),
      maintenance: count('maintenance'),
    };
  };
}
