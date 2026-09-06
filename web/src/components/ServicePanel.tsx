import type { ReactNode } from 'react';
import type { SourceResult } from '../types';
import { Panel } from './Panel';

interface ServicePanelProps<T> {
  title: string;
  result: SourceResult<T> | null;
  /** The .env keys that switch the service on, named in the empty state. */
  envKeys: string[];
  aside?: (data: T) => ReactNode;
  children: (data: T) => ReactNode;
}

/**
 * The three states every polled service shares: not configured (a resting
 * state, so it names the .env keys rather than shouting), unreachable (the
 * server's own error, verbatim), and data. Panels only write the last one.
 */
export function ServicePanel<T>({ title, result, envKeys, aside, children }: ServicePanelProps<T>) {
  if (!result) {
    return (
      <Panel title={title} aside="not configured">
        <p className="empty">
          Set {envKeys.join(' and ')} in <code>.env</code> and restart to switch this panel on.
        </p>
      </Panel>
    );
  }

  if (!result.ok) {
    return (
      <Panel title={title} aside="unreachable">
        <p className="empty text-alert">{result.error}</p>
      </Panel>
    );
  }

  return (
    <Panel title={title} aside={aside?.(result.data)}>
      {children(result.data)}
    </Panel>
  );
}
