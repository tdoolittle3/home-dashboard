import { formatMb, formatRelative, formatState, isProblem, labelFor } from '../format';
import { splitStorage } from '../storage';
import type { EntityRef, EntitySnapshot, SourceResult, FrigateSummary } from '../types';
import { DiskPie } from './DiskPie';
import { Panel } from './Panel';

interface StoragePanelProps {
  title: string;
  refs: EntityRef[];
  entities: Record<string, EntitySnapshot>;
  frigate: SourceResult<FrigateSummary> | null;
}

/**
 * The disk chart and Home Assistant's storage sensors in one panel: the two
 * describe the same drive from different angles, so splitting them across the
 * page made the reader hold both halves in their head.
 *
 * Frigate's figures come from inside its container and HA's from the host, so
 * the two disagree slightly - HA counts the root filesystem where Frigate counts
 * its own mount, and ext4's reserved blocks land on different sides of that
 * line. Both are shown as reported rather than reconciled into a single number.
 */
export function StoragePanel({ title, refs, entities, frigate }: StoragePanelProps) {
  const { disk, others } = frigate?.ok ? splitStorage(frigate.data.storage) : { disk: undefined, others: [] };

  return (
    <Panel title={title}>
      {disk ? (
        <DiskPie
          mount={disk.mount}
          alsoServes={disk.alsoServes}
          totalMb={disk.totalMb}
          usedMb={disk.usedMb}
          freeMb={disk.freeMb}
        />
      ) : null}

      <h3 className="subhead">Storage guard</h3>
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

      {others.length > 0 ? (
        <>
          <h3 className="subhead">Other mounts</h3>
          <ul className="rows rows--tight">
            {others.map((group) => (
              <li key={group.mount} className="row">
                <span className="row__label">{[group.mount, ...group.alsoServes].join(', ')}</span>
                <span className="row__value">{formatMb(group.usedMb)} used</span>
                <span className="row__meta">{formatMb(group.freeMb)} free</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Panel>
  );
}
