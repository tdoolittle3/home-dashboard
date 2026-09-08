import type { ControlAction, EntitySnapshot, HaStatus, HistoryPoint, Snapshot, SourcesSnapshot } from './types';

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

export interface StreamHandlers {
  onSnapshot: (snapshot: Snapshot) => void;
  onEntity: (entity: EntitySnapshot) => void;
  onHaStatus: (status: HaStatus) => void;
  onSources: (sources: SourcesSnapshot) => void;
  onOpen: () => void;
  onError: () => void;
}

/** EventSource handles its own reconnect, so there is no retry logic here. */
export function openStream(handlers: StreamHandlers): () => void {
  const source = new EventSource('/api/stream');

  const listen = <T>(event: string, handler: (payload: T) => void): void => {
    source.addEventListener(event, (message) => {
      try {
        handler(JSON.parse((message as MessageEvent<string>).data) as T);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    });
  };

  source.addEventListener('open', handlers.onOpen);
  source.addEventListener('error', handlers.onError);
  listen<Snapshot>('snapshot', handlers.onSnapshot);
  listen<EntitySnapshot>('state', handlers.onEntity);
  listen<HaStatus>('ha', handlers.onHaStatus);
  listen<SourcesSnapshot>('sources', handlers.onSources);

  return () => source.close();
}
