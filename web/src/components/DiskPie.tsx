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

interface Slice {
  key: 'used' | 'free' | 'reserved';
  label: string;
  megabytes: number;
}

const SIZE = 168;
const RADIUS = 80;
/** Radius of the hole the headline figure sits in. */
const HOLE = 55;
const CENTER = SIZE / 2;

/** A reserved remainder smaller than this reads as a rendering artefact, not data. */
const RESERVED_FLOOR = 0.005;

/**
 * Point on the circle at `fraction` of a full turn, starting at 12 o'clock and
 * running clockwise so the first slice reads from the top like a clock face.
 */
function pointAt(fraction: number): [number, number] {
  const angle = -Math.PI / 2 + fraction * 2 * Math.PI;
  return [CENTER + RADIUS * Math.cos(angle), CENTER + RADIUS * Math.sin(angle)];
}

function round(value: number): string {
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
    `L ${round(x0)} ${round(y0)}`,
    `A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${round(x1)} ${round(y1)}`,
    'Z',
  ].join(' ');
}

/**
 * Part-to-whole for one filesystem, drawn as a ring with the used share as the
 * headline figure in the middle.
 *
 * ext4 holds back about 5% of the disk for root, so `used + free` lands short of
 * the reported size - on ladybird's drive by roughly 23 GB. That gap is shown as
 * its own slice rather than absorbed into the free wedge, which would draw free
 * larger than its own label claims. Percentages are taken against the sum of the
 * slices actually drawn, so the geometry and the labels cannot disagree; the
 * headline is the same share rounded to a whole number, and the legend keeps
 * the decimal.
 *
 * The wedges are full sectors from the centre; the hole is a surface-coloured
 * disc laid over them. The geometry underneath is still a pie that sums to 100%.
 *
 * Fills are --chart-used / --chart-free / --chart-reserved, validated together
 * against --surface with the dataviz validator in dark mode, all pairs.
 */
export function DiskPie({ mount, alsoServes = [], totalMb, usedMb, freeMb }: DiskPieProps) {
  const slices: Slice[] = [
    { key: 'used', label: 'Used', megabytes: Math.max(usedMb, 0) },
    { key: 'free', label: 'Free', megabytes: Math.max(freeMb, 0) },
  ];

  const reservedMb = totalMb - usedMb - freeMb;
  if (reservedMb > totalMb * RESERVED_FLOOR) {
    slices.push({ key: 'reserved', label: 'Reserved', megabytes: reservedMb });
  }

  const whole = slices.reduce((sum, slice) => sum + slice.megabytes, 0);
  const share = (megabytes: number) => (whole > 0 ? megabytes / whole : 0);

  let cursor = 0;
  const wedges = slices.map((slice) => {
    const start = cursor;
    // The final wedge closes on 1 exactly, so rounding cannot leave a hairline.
    cursor += share(slice.megabytes);
    return { slice, start, end: slice === slices[slices.length - 1] ? 1 : cursor };
  });

  const usedPercent = Math.round(share(slices[0]?.megabytes ?? 0) * 100);

  const summary = [
    `${mount}:`,
    ...slices.map((slice) => `${slice.label} ${formatMb(slice.megabytes)}`),
    `of ${formatMb(totalMb)} total`,
  ].join(' ');

  return (
    <div className="disk">
      <div className="disk__row">
        <div className="disk__chart">
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} role="img" aria-label={summary}>
            {/* Slices carry a 2px stroke in the surface colour: that is the gap
                between them, not an outline drawn around them. */}
            {wedges.map(({ slice, start, end }) => (
              <path
                key={slice.key}
                className={`disk__slice disk__slice--${slice.key}`}
                d={wedgePath(start, end)}
              >
                <title>{`${slice.label} ${formatMb(slice.megabytes)} (${formatNumber(share(slice.megabytes) * 100)}%)`}</title>
              </path>
            ))}
            <circle className="disk__hole" cx={CENTER} cy={CENTER} r={HOLE} />
          </svg>
          <div className="disk__hero">
            <div className="disk__hero-value">
              {usedPercent}
              <span className="disk__hero-unit">%</span>
            </div>
            <div className="disk__hero-label">used</div>
          </div>
        </div>

        <div className="disk__side">
          <ul className="disk__legend">
            {slices.map((slice) => (
              <li key={slice.key} className="disk__key">
                <span className={`disk__swatch disk__swatch--${slice.key}`} aria-hidden="true" />
                <span className="disk__key-label">{slice.label}</span>
                <span className="disk__key-value">{formatMb(slice.megabytes)}</span>
                <span className="disk__key-pct">{formatNumber(share(slice.megabytes) * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="disk__caption">
        {[mount, ...alsoServes].join(', ')}
        <span className="disk__caption-extra"> · {formatMb(totalMb)} total</span>
      </p>
    </div>
  );
}
