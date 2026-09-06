import type { FrigateSummary } from './types';

export interface MountGroup {
  mount: string;
  /** Other mount paths that report identical figures, so share a filesystem. */
  alsoServes: string[];
  totalMb: number | null;
  usedMb: number | null;
  freeMb: number | null;
}

export type SizedMountGroup = MountGroup & { totalMb: number; usedMb: number; freeMb: number };

/**
 * Frigate reports one row per configured path, so several paths on one
 * filesystem come back with identical figures - on this host `recordings` and
 * `clips` are the same disk. Group by those figures so the same drive is not
 * counted or drawn twice.
 */
export function groupMounts(storage: FrigateSummary['storage']): MountGroup[] {
  const groups = new Map<string, MountGroup>();

  for (const entry of storage) {
    const key = `${entry.totalMb}|${entry.usedMb}|${entry.freeMb}`;
    const existing = groups.get(key);
    if (existing) {
      existing.alsoServes.push(entry.mount);
    } else {
      groups.set(key, {
        mount: entry.mount,
        alsoServes: [],
        totalMb: entry.totalMb,
        usedMb: entry.usedMb,
        freeMb: entry.freeMb,
      });
    }
  }

  return [...groups.values()];
}

export function hasSizes(group: MountGroup): group is SizedMountGroup {
  return group.totalMb !== null && group.usedMb !== null && group.freeMb !== null && group.totalMb > 0;
}

/**
 * The hard drive is the largest filesystem Frigate reports; the remainder are
 * small tmpfs mounts that say more as a line of text than as a chart.
 */
export function splitStorage(storage: FrigateSummary['storage']): {
  disk: SizedMountGroup | undefined;
  others: MountGroup[];
} {
  const groups = groupMounts(storage);
  const disk = groups.filter(hasSizes).sort((a, b) => b.totalMb - a.totalMb)[0];
  return { disk, others: groups.filter((group) => group !== disk) };
}
