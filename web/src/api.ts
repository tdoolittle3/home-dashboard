import type {
  ControlAction,
  EntitySnapshot,
  HaStatus,
  HistoryPoint,
  MeshSummary,
  Snapshot,
  SourcesSnapshot,
} from './types';

export async function fetchSnapshot(): Promise<Snapshot> {
  const response = await fetch('/api/dashboard');
  if (!response.ok) throw new Error(`dashboard request failed: ${response.status}`);
  return (await response.json()) as Snapshot;
}

export async function fetchHistory(entityId: string, hours: number): Promise<HistoryPoint[]> {
  const response = await fetch(`/api/history/${encodeURIComponent(entityId)}?hours=${hours}`);
  if (!response.ok) throw new Error(`history request failed: ${response.status}`);
  const body = (await response.json()) as { points?: HistoryPoint[] };
  return body.points ?? [];
}

export async function sendAction(entityId: string, action: ControlAction): Promise<void> {
  const response = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_id: entityId, action }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `action failed: ${response.status}`);
  }
}

export async function sendMeshText(text: string, channel: string): Promise<void> {
  const response = await fetch('/api/mesh/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, channel }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `mesh send failed: ${response.status}`);
  }
}

/** Reboots the machine the dashboard runs on. Resolves once the server has started the reboot. */
export async function restartHost(): Promise<void> {
  const response = await fetch('/api/host/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'restart' }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `restart failed: ${response.status}`);
  }
}

export interface StreamHandlers {
  onSnapshot: (snapshot: Snapshot) => void;
  onEntity: (entity: EntitySnapshot) => void;
  onHaStatus: (status: HaStatus) => void;
  onSources: (sources: SourcesSnapshot) => void;
  onMesh: (mesh: MeshSummary) => void;
  onOpen: () => void;
  onError: () => void;
}

const STREAM_RETRY_MS = 3_000;

/**
 * EventSource retries dropped connections itself, but gives up for good (readyState
 * CLOSED) when the server answers with an error status - e.g. a 502 from the proxy
 * mid-deploy. In that case reopen it by hand after a short delay.
 */
export function openStream(handlers: StreamHandlers): () => void {
  let source: EventSource | null = null;
  let retry: number | undefined;
  let stopped = false;

  const connect = (): void => {
    const next = new EventSource('/api/stream');
    source = next;

    const listen = <T>(event: string, handler: (payload: T) => void): void => {
      next.addEventListener(event, (message) => {
        try {
          handler(JSON.parse((message as MessageEvent<string>).data) as T);
        } catch {
          // A malformed frame is not worth tearing the stream down for.
        }
      });
    };

    next.addEventListener('open', handlers.onOpen);
    next.addEventListener('error', () => {
      handlers.onError();
      if (!stopped && next.readyState === EventSource.CLOSED) {
        retry = window.setTimeout(connect, STREAM_RETRY_MS);
      }
    });
    listen<Snapshot>('snapshot', handlers.onSnapshot);
    listen<EntitySnapshot>('state', handlers.onEntity);
    listen<HaStatus>('ha', handlers.onHaStatus);
    listen<SourcesSnapshot>('sources', handlers.onSources);
    listen<MeshSummary>('mesh', handlers.onMesh);
  };

  connect();

  return () => {
    stopped = true;
    window.clearTimeout(retry);
    source?.close();
  };
}
