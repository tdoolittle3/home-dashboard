import { describe, expect, it } from 'vitest';
import { collapseRepeats, type FrigateEvent } from '../src/sources/frigate.js';

const MIN = 60;

function event(over: Partial<FrigateEvent> & { id: string }): FrigateEvent {
  return {
    camera: 'driveway',
    label: 'car',
    startTime: 10_000,
    endTime: null,
    score: null,
    hasSnapshot: true,
    hasClip: true,
    zones: [],
    count: 1,
    ...over,
  };
}

describe('collapseRepeats', () => {
  it('folds repeated vehicle detections on the same camera and zone into the newest event', () => {
    // Input is newest first, like Frigate returns it.
    const rows = collapseRepeats([
      event({ id: 'c', startTime: 10_000 }),
      event({ id: 'b', startTime: 10_000 - 10 * MIN }),
      event({ id: 'a', startTime: 10_000 - 20 * MIN }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'c', count: 3 });
  });

  it('chains a parked car into one row however long it sits', () => {
    const rows = collapseRepeats(
      [0, 25, 50, 75, 100].map((m, i) => event({ id: `e${i}`, startTime: 100_000 - m * MIN })),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(5);
  });

  it('keeps vehicles apart when the gap exceeds the window', () => {
    const rows = collapseRepeats([
      event({ id: 'new', startTime: 100_000 }),
      event({ id: 'old', startTime: 100_000 - 31 * MIN }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('never folds people, even back to back', () => {
    const rows = collapseRepeats([
      event({ id: 'p2', label: 'person', startTime: 10_000 }),
      event({ id: 'p1', label: 'person', startTime: 9_990 }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('treats different cameras, zones, or labels as different groups', () => {
    const rows = collapseRepeats([
      event({ id: '1' }),
      event({ id: '2', camera: 'backyard' }),
      event({ id: '3', zones: ['driveway'] }),
      event({ id: '4', label: 'truck' }),
    ]);
    expect(rows).toHaveLength(4);
  });

  it('keeps events with no start time rather than guessing', () => {
    const rows = collapseRepeats([event({ id: 'a', startTime: null }), event({ id: 'b', startTime: null })]);
    expect(rows).toHaveLength(2);
  });

  it('ignores zone order when grouping', () => {
    const rows = collapseRepeats([
      event({ id: 'b', zones: ['yard', 'drive'], startTime: 10_000 }),
      event({ id: 'a', zones: ['drive', 'yard'], startTime: 9_000 }),
    ]);
    expect(rows).toHaveLength(1);
  });
});
