import { formatMb, formatNumber } from '../format';

interface DiskPieProps {
  /** Primary mount name, used as the caption. */
  mount: string;
  /** Other mounts backed by the same filesystem, so the caption can say so. */
  alsoServes?: string[];
  totalMb: number;
  usedMb: number;
  freeMb: number;
}

const SIZE = 132;
const RADIUS = 62;
const CENTER = SIZE / 2;

/**
 * Point on the circle at `fraction` of a full turn, starting at 12 o'clock and
 * running clockwise so the first slice reads from the top like a clock face.
 */
function pointAt(fraction: number): [number, number] {
  const angle = -Math.PI / 2 + fraction * 2 * Math.PI;
  return [CENTER + RADIUS * Math.cos(angle), CENTER + RADIUS * Math.sin(angle)];
}

function sliceRounded(value: number): string {
  return value.toFixed(3);
}

/**
 * Wedge path from `start` to `end` as fractions of a full turn. A wedge covering
 * the whole circle has no distinct start and end point, so an arc command would
 * collapse to nothing - draw it as two half arcs instead.
 */
function wedgePath(start: number, end: number): string {
  const span = end - start;
  if (span >= 0.999) {
    const top = CENTER - RADIUS;
    const bottom = CENTER + RADIUS;
    return `M ${CENTER} ${top} A ${RADIUS} ${RADIUS} 0 1 1 ${CENTER} ${bottom} A ${RADIUS} ${RADIUS} 0 1 1 ${CENTER} ${top} Z`;
  }

  const [x0, y0] = pointAt(start);
  const [x1, y1] = pointAt(end);
  const largeArc = span > 0.5 ? 1 : 0;
  return [
    `M ${CENTER} ${CENTER}`,
    `L ${sliceRounded(x0)} ${sliceRounded(y0)}`,
    `A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${sliceRounded(x1)} ${sliceRounded(y1)}`,
    'Z',
  ].join(' ');
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return (part / whole) * 100;
}

/**
 * Part-to-whole for one filesystem. Two slices earn a pie only because the
 * reader's question is "how much of the disk is gone" - the exact figures sit in
 * the legend beside it, so nothing here is gated behind reading the colours.
 */
export function DiskPie({ mount, alsoServes = [], totalMb, usedMb, freeMb }: DiskPieProps) {
  const usedPct = percent(usedMb, totalMb);
  const freePct = percent(freeMb, totalMb);
  const usedFraction = totalMb > 0 ? usedMb / totalMb : 0;

  const summary = `${mount}: ${formatMb(usedMb)} used of ${formatMb(totalMb)}, ${formatNumber(usedPct)} percent`;

  return (
    <div className="disk">
      <svg
        className="disk__chart"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        role="img"
        aria-label={summary}
      >
        {/* Slices carry a 2px stroke in the surface colour: that is the gap
            between them, not an outline drawn around them. */}
        <path className="disk__slice disk__slice--used" d={wedgePath(0, usedFraction)}>
          <title>{`Used ${formatMb(usedMb)} (${formatNumber(usedPct)}%)`}</title>
        </path>
        <path className="disk__slice disk__slice--free" d={wedgePath(usedFraction, 1)}>
          <title>{`Free ${formatMb(freeMb)} (${formatNumber(freePct)}%)`}</title>
        </path>
      </svg>

      <div className="disk__side">
        <ul className="disk__legend">
          <li className="disk__key">
            <span className="disk__swatch disk__swatch--used" aria-hidden="true" />
            <span className="disk__key-label">Used</span>
            <span className="disk__key-value">{formatMb(usedMb)}</span>
            <span className="disk__key-pct">{formatNumber(usedPct)}%</span>
          </li>
          <li className="disk__key">
            <span className="disk__swatch disk__swatch--free" aria-hidden="true" />
            <span className="disk__key-label">Free</span>
            <span className="disk__key-value">{formatMb(freeMb)}</span>
            <span className="disk__key-pct">{formatNumber(freePct)}%</span>
          </li>
        </ul>
        <p className="disk__caption">
          {mount}
          {alsoServes.length > 0 ? (
            <span className="disk__caption-extra">
              {' '}
              and {alsoServes.join(', ')}
            </span>
          ) : null}
          <span className="disk__caption-extra"> · {formatMb(totalMb)} total</span>
        </p>
      </div>
    </div>
  );
}
