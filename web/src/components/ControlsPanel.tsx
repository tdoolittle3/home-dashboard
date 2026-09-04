import { useState } from 'react';
import { sendAction } from '../api';
import { formatState, isOn, labelFor } from '../format';
import type { EntityRef, EntitySnapshot } from '../types';
import { Panel } from './Panel';

interface ControlsPanelProps {
  title: string;
  refs: EntityRef[];
  entities: Record<string, EntitySnapshot>;
}

export function ControlsPanel({ title, refs, entities }: ControlsPanelProps) {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // No optimistic state: the switch reports back over the stream, and pretending
  // otherwise would lie about a camera light that failed to turn on.
  const toggle = async (entityId: string): Promise<void> => {
    setPending((current) => ({ ...current, [entityId]: true }));
    setError(null);
    try {
      await sendAction(entityId, 'toggle');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending((current) => ({ ...current, [entityId]: false }));
    }
  };

  return (
    <Panel title={title} aside={error ? <span className="text-alert">{error}</span> : null}>
      <ul className="rows">
        {refs.map((ref) => {
          const entity = entities[ref.entity_id];
          const on = isOn(entity);
          const busy = pending[ref.entity_id] === true;
          return (
            <li key={ref.entity_id} className="row">
              <span className="row__label">{labelFor(ref, entity)}</span>
              <span className="row__value">{formatState(entity)}</span>
              <button
                type="button"
                className={on ? 'toggle toggle--on' : 'toggle'}
                disabled={busy || entity?.missing !== false}
                aria-pressed={on}
                onClick={() => void toggle(ref.entity_id)}
              >
                {busy ? '...' : on ? 'On' : 'Off'}
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
