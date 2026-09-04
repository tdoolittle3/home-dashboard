import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSnapshot, openStream } from './api';
import type { Snapshot } from './types';

export type StreamState = 'connecting' | 'live' | 'offline';

export interface DashboardHook {
  snapshot: Snapshot | null;
  stream: StreamState;
  error: string | null;
  reload: () => void;
}

export function useDashboard(): DashboardHook {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [stream, setStream] = useState<StreamState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const mounted = useRef(true);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // One eager fetch so the page paints before the stream's own snapshot lands.
    fetchSnapshot()
      .then((fresh) => {
        if (mounted.current) {
          setSnapshot(fresh);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      });

    const close = openStream({
      onOpen: () => setStream('live'),
      onError: () => setStream('offline'),
      onSnapshot: (fresh) => {
        setSnapshot(fresh);
        setStream('live');
        setError(null);
      },
      onEntity: (entity) => {
        setSnapshot((current) =>
          current ? { ...current, entities: { ...current.entities, [entity.entity_id]: entity } } : current,
        );
      },
      onHaStatus: (ha) => {
        setSnapshot((current) => (current ? { ...current, ha } : current));
      },
      onSources: (sources) => {
        setSnapshot((current) =>
          current ? { ...current, sources, generatedAt: new Date().toISOString() } : current,
        );
      },
    });

    return close;
  }, [reloadKey]);

  return { snapshot, stream, error, reload };
}
