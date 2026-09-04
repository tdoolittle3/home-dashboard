import { formatRelative, formatState, isProblem, labelFor } from '../format';
import type { EntityRef, EntitySnapshot } from '../types';
import { Panel } from './Panel';

interface EntitiesPanelProps {
  title: string;
  refs: EntityRef[];
  entities: Record<string, EntitySnapshot>;
}

export function EntitiesPanel({ title, refs, entities }: EntitiesPanelProps) {
  return (
    <Panel title={title}>
      <ul className="rows">
        {refs.map((ref) => {
          const entity = entities[ref.entity_id];
          return (
            <li key={ref.entity_id} className="row">
              <span className="row__label">{labelFor(ref, entity)}</span>
              <span className={isProblem(entity) ? 'row__value row__value--alert' : 'row__value'}>
                {formatState(entity)}
              </span>
              <span className="row__meta">{formatRelative(entity?.lastChanged ?? null)}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
