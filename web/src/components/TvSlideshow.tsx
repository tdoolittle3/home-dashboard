import { useEffect, useRef, useState } from 'react';

interface TvSlideshowProps {
  /** Dwell per photo. The crossfade rides on top of this. */
  seconds: number;
}

/** A failed fetch of the id list retries sooner than the photo cadence, but never hammers. */
const RETRY_MS = 60_000;

async function fetchAssetIds(): Promise<string[]> {
  const response = await fetch('/api/photos/slideshow');
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `slideshow request failed: ${response.status}`);
  }
  const body = (await response.json()) as { assets?: string[] };
  return body.assets ?? [];
}

/**
 * The /tv photo band. Exactly two <img> elements exist for the page's whole
 * life - the hidden one preloads the next photo and a crossfade swaps them -
 * because this page runs for days on a TV with little RAM to leak.
 */
export function TvSlideshow({ seconds }: TvSlideshowProps) {
  const [slots, setSlots] = useState<(string | null)[]>([null, null]);
  const [front, setFront] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The walk through the album lives in a ref: timers advance it without
  // re-running the effect, and the cleanup flag stops a swap landing after unmount.
  const walk = useRef({ assets: [] as string[], index: 0, front: 0, stopped: false });

  useEffect(() => {
    const state = walk.current;
    state.stopped = false;
    let timer: number | undefined;

    // Decode off-DOM first, so a broken or slow asset is skipped, never flashed.
    const preload = (src: string): Promise<boolean> =>
      new Promise((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve(true);
        probe.onerror = () => resolve(false);
        probe.src = src;
      });

    const nextSrc = async (): Promise<string | null> => {
      if (state.index >= state.assets.length) {
        // End of the lap: ask again - the server reshuffles and picks up album edits.
        state.assets = await fetchAssetIds();
        state.index = 0;
      }
      const id = state.assets[state.index++];
      return id === undefined ? null : `/api/photos/${encodeURIComponent(id)}/preview`;
    };

    const advance = async (): Promise<void> => {
      // A handful of attempts, so one missing asset skips ahead but a fully
      // broken album does not spin the loop.
      for (let attempt = 0; attempt < 5; attempt++) {
        const src = await nextSrc();
        if (src === null) return;
        if (!(await preload(src))) continue;
        if (state.stopped) return;
        const back = state.front === 0 ? 1 : 0;
        setSlots((current) => current.map((slot, i) => (i === back ? src : slot)));
        setFront(back);
        state.front = back;
        return;
      }
    };

    const tick = async (): Promise<void> => {
      let failed = false;
      try {
        await advance();
        setError(null);
      } catch (cause) {
        failed = true;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (state.stopped) return;
      timer = window.setTimeout(() => void tick(), failed ? RETRY_MS : Math.max(seconds, 3) * 1000);
    };

    void tick();
    return () => {
      state.stopped = true;
      window.clearTimeout(timer);
    };
  }, [seconds]);

  const empty = slots[0] === null && slots[1] === null;
  return (
    <div className="tv-slideshow">
      {slots.map((src, i) =>
        src === null ? null : (
          <img
            // The index is the identity on purpose: two img nodes, reused forever.
            key={i}
            className={i === front ? 'tv-slideshow__img tv-slideshow__img--front' : 'tv-slideshow__img'}
            src={src}
            alt=""
          />
        ),
      )}
      {empty ? <p className="tv-slideshow__note">{error ? `photos: ${error}` : 'photos loading…'}</p> : null}
    </div>
  );
}
