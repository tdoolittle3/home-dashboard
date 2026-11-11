import { formatMb, formatRelative, formatState, isProblem, labelFor } from '../format';
import { splitStorage, toMb } from '../storage';
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
 * page made the reader hold both halves in their head. When the panel is wide
 * enough the chart sits beside the sensor rows; on a phone they stack.
 *
 * Frigate's figures come from inside its container and HA's from the host, so
 * the two disagree slightly - HA counts the root filesystem where Frigate counts
 * its own mount, and ext4's reserved blocks land on different sides of that
 * line. Both are shown as reported rather than reconciled into a single number.
 */
export function StoragePanel({ title, refs, entities, frigate }: StoragePanelProps) {
  const { disk, others } = frigate?.ok ? splitStorage(frigate.data.storage) : { disk: undefined, others: [] };

  // slice refs become wedges of the pie; the rest stay text rows. A slice
  // sensor with no pie to live in (Frigate down) or no readable size falls
  // back to a row rather than silently vanishing from the panel.
  const asWedge = (ref: EntityRef) => disk !== undefined && ref.slice === true && toMb(entities[ref.entity_id]) !== null;
  const carve = refs.filter(asWedge).map((ref) => ({
    label: labelFor(ref, entities[ref.entity_id]),
    megabytes: toMb(entities[ref.entity_id]) as number,
  }));
  const rowRefs = refs.filter((ref) => !asWedge(ref));

  return (
    <Panel title={title}>
      <div className="storage">
        <div className={disk ? 'storage__grid storage__grid--pair' : 'storage__grid'}>
          {disk ? (
            <div className="storage__lead">
              <DiskPie
                mount={disk.mount}
                alsoServes={disk.alsoServes}
                totalMb={disk.totalMb}
                usedMb={disk.usedMb}
                freeMb={disk.freeMb}
                carve={carve}
              />
            </div>
          ) : null}

          <div className="storage__detail">
            <h3 className="subhead">Storage guard</h3>
            <ul className="rows">
              {rowRefs.map((ref) => {
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
          </div>
        </div>

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
      </div>
    </Panel>
  );
}
