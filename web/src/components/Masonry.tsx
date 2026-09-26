import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface MasonryItem {
  key: string;
  node: ReactNode;
}

interface MasonryProps {
  columns: number;
  /** Always heads the last column, ahead of the balanced items. */
  pinned?: ReactNode;
  items: MasonryItem[];
}

const PINNED = '__pinned';
const GAP = 16;

/**
 * Balanced columns for the desktop layout. Panels are dealt in config order,
 * each to whichever column is currently shortest, using their measured heights.
 *
 * A live dashboard's panels grow and shrink all the time (flights come and go,
 * query lists refill), and re-dealing on every change would make panels hop
 * between columns. So the deal is kept until a panel's height moves well away
 * from the height it was dealt with, or the column count changes.
 */
export function Masonry({ columns, pinned, items }: MasonryProps) {
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const dealtWith = useRef(new Map<string, number>());
  const [placement, setPlacement] = useState<Record<string, number>>({});

  const itemKeys = items.map((item) => item.key).join('|');
  const hasPinned = Boolean(pinned);

  const measure = () => {
    const heights = new Map<string, number>();
    for (const [key, node] of nodes.current) heights.set(key, node.getBoundingClientRect().height);
    return heights;
  };

  const deal = (heights: Map<string, number>) => {
    const fill = new Array<number>(columns).fill(0);
    if (hasPinned) fill[columns - 1] = (heights.get(PINNED) ?? 0) + GAP;
    const next: Record<string, number> = {};
    for (const item of items) {
      let target = 0;
      for (let col = 1; col < columns; col++) if (fill[col]! < fill[target]!) target = col;
      next[item.key] = target;
      fill[target]! += (heights.get(item.key) ?? 0) + GAP;
    }
    dealtWith.current = heights;
    setPlacement(next);
  };

  // Deal before paint whenever the set of panels or the column count changes.
  // The rendered nodes are new every snapshot, so they are not a dependency.
  useLayoutEffect(() => {
    deal(measure());
  }, [columns, itemKeys, hasPinned]);

  // A panel that moves column remounts as a new node, so watch afresh after
  // every deal.
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      const heights = measure();
      const drifted = [...heights].some(([key, height]) => {
        const before = dealtWith.current.get(key) ?? 0;
        const change = Math.abs(height - before);
        return change > 160 && change > before * 0.25;
      });
      if (drifted) deal(heights);
    });
    for (const node of nodes.current.values()) observer.observe(node);
    return () => observer.disconnect();
  });

  const register = (key: string) => (node: HTMLDivElement | null) => {
    if (node) nodes.current.set(key, node);
    else nodes.current.delete(key);
  };

  const cols: ReactNode[][] = Array.from({ length: columns }, () => []);
  if (pinned) {
    cols[columns - 1]!.push(
      <div key={PINNED} ref={register(PINNED)} className="masonry__item">
        {pinned}
      </div>,
    );
  }
  items.forEach((item, index) => {
    const col = Math.min(placement[item.key] ?? index % columns, columns - 1);
    cols[col]!.push(
      <div key={item.key} ref={register(item.key)} className="masonry__item">
        {item.node}
      </div>,
    );
  });

  return (
    <div className="masonry" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {cols.map((children, index) => (
        <div key={index} className="masonry__col">
          {children}
        </div>
      ))}
    </div>
  );
}
