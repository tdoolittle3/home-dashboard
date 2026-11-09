import type { ReactNode } from 'react';

/**
 * The Services tile glyphs: plain strokes on a 24-unit grid, drawn to read at
 * 16px. Config picks one by name ("icon" on a link entry); anything not in the
 * map falls back to the generic link glyph, so a typo degrades to the default
 * rather than a blank chip.
 */
const GLYPHS: Record<string, ReactNode> = {
  home: (
    <>
      <path d="M3 11.2 12 4l9 7.2" />
      <path d="M5.5 9.8V20h13V9.8" />
      <path d="M10 20v-5.5h4V20" />
    </>
  ),
  camera: (
    <>
      <rect x="2.5" y="7" width="12.5" height="10" rx="2" />
      <path d="M15 10.8 21 7.5v9l-6-3.3" />
    </>
  ),
  play: <path d="M8.5 5.8v12.4a0.4 0.4 0 0 0 .62.34l9.7-6.2a0.4 0.4 0 0 0 0-.68l-9.7-6.2a0.4 0.4 0 0 0-.62.34Z" />,
  pulse: <path d="M3 12.5h3.5L9 6l4.5 12 2.3-5.5H21" />,
  photo: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.6" cy="10" r="1.6" />
      <path d="M4.5 17.5 9.5 13l3.4 3.2 3.3-3.8 3.3 4" />
    </>
  ),
  shield: <path d="M12 3.2 19.5 6v5.8c0 4.6-3.2 7.5-7.5 9-4.3-1.5-7.5-4.4-7.5-9V6Z" />,
  key: (
    <>
      <circle cx="7.6" cy="15.4" r="3.6" />
      <path d="M10.4 12.6 19.6 3.4M16.2 6.8l2.8 2.8M13.4 9.6l2 2" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="8.5" width="16" height="11" rx="3" />
      <path d="M12 8.5V5.4" />
      <circle cx="12" cy="4.2" r="1.2" />
      {/* Eyes as short strokes - filled dots vanish at 16px, and without them
          the chip is just another rounded rect next to the tv glyph. */}
      <path d="M9 12.8v2.4M15 12.8v2.4" />
    </>
  ),
  report: (
    <>
      <path d="M6.5 3.5h7.5l4 4V20.5h-11.5Z" />
      <path d="M14 3.5v4h4" />
      <path d="M9.5 17v-3M12.5 17v-5.5M15.5 17v-2" />
    </>
  ),
  chart: (
    <>
      <path d="M4 4.5v15h16" />
      <path d="M7 15.5 10.8 11l2.8 2.6 4.6-5.8" />
    </>
  ),
  flow: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
      <path d="M10 6.5h5.5a2 2 0 0 1 2 2V14" />
    </>
  ),
  plane: <path d="M21.5 2.5 11 13M21.5 2.5l-6.8 18.7-3.2-8.2-8.2-3.2Z" />,
  radio: (
    <>
      <circle cx="12" cy="10.5" r="1.8" />
      <path d="M8.4 7a5.1 5.1 0 0 0 0 7M15.6 7a5.1 5.1 0 0 1 0 7" />
      <path d="M5.6 4.4a9 9 0 0 0 0 12.2M18.4 4.4a9 9 0 0 1 0 12.2" />
      <path d="M12 12.6V21" />
    </>
  ),
  tv: (
    <>
      <rect x="3" y="7.5" width="18" height="13" rx="2" />
      <path d="M8.5 3.5 12 7l3.5-3.5" />
    </>
  ),
  link: (
    <>
      <path d="M9.5 14.5a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1.3 1.3" />
      <path d="M14.5 9.5a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1.3-1.3" />
    </>
  ),
};

export const TILE_ICONS = Object.keys(GLYPHS);

export function TileIcon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name] ?? GLYPHS['link']}
    </svg>
  );
}
