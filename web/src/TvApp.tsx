import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TvAdsbMap } from './components/AdsbPanel';
import { CamerasPanel } from './components/CamerasPanel';
import { CameraViewer } from './components/CameraViewer';
import { EntitiesPanel } from './components/EntitiesPanel';
import { StoragePanel } from './components/StoragePanel';
import { TvSlideshow } from './components/TvSlideshow';
import { TvStatusBar } from './components/TvStatusBar';
import { formatState } from './format';
import type { Panel, TvRoom } from './types';
import { useDashboard } from './useDashboard';

const STREAM_LABEL: Record<string, string> = {
  connecting: 'connecting',
  live: 'live',
  offline: 'reconnecting',
};

/**
 * This page runs for days on the TV. A periodic reload sheds whatever the
 * WebView has slowly accreted (detached DOM, image cache, a wedged stream)
 * and picks up fresh deploys as a side effect.
 */
const SOFT_RELOAD_MS = 6 * 60 * 60 * 1000;

/**
 * Panel types that never write - the only ones a /tv room may show. Of the
 * service panels only uptimeKuma renders here (renderPanel); the others are
 * link-oriented and a TV can't follow links.
 */
const LOOK_ONLY_TYPES = new Set(['entities', 'system', 'ups', 'adsb', 'service']);

/** The design canvas: everything lays out at 1080p and scales to the screen. */
const STAGE_W = 1920;
const STAGE_H = 1080;

/** The D-pad focus ring fades after this much inactivity; the page is ambient first. */
const RING_HIDE_MS = 15 * 1000;

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(interval);
  }, []);
  return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Fit the fixed 1920x1080 stage to the real viewport. The Fire TV's WebView
 * lays pages out in a ~960x540 CSS viewport (1080p at density 2), which is
 * why the page looked double-sized when it was designed against the viewport;
 * scaling a fixed canvas is exact there (0.5 -> one canvas px per device px)
 * and letterboxes anywhere else. The vars live on <html> so the stage element
 * may unmount and remount (loading -> loaded) without losing them; JS computes
 * the scale because the TV's Chromium may predate unitless calc() division.
 */
function useTvStage(): void {
  useLayoutEffect(() => {
    document.body.classList.add('tv-page');
    const style = document.documentElement.style;
    const apply = () => {
      const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
      style.setProperty('--tv-scale', String(scale));
      style.setProperty('--tv-x', `${(window.innerWidth - STAGE_W * scale) / 2}px`);
      style.setProperty('--tv-y', `${(window.innerHeight - STAGE_H * scale) / 2}px`);
    };
    apply();
    window.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('resize', apply);
      document.body.classList.remove('tv-page');
      style.removeProperty('--tv-scale');
      style.removeProperty('--tv-x');
      style.removeProperty('--tv-y');
    };
  }, []);
}

/**
 * The look-only page the Fire TV shows (tv-app/ wraps it in a WebView).
 * Reuses the dashboard's own panels; a blanket pointer-events: none in the
 * .tv styles is what makes them inert, not forked components. ?room=<name>
 * picks a preset from dashboard.json's tv.rooms; no match falls back to the
 * room named "default", then to everything.
 *
 * The one interactive layer rides the remote, not the pointer: arrows move a
 * focus ring along the hero cameras, OK opens the focused camera's live
 * viewer, OK again closes it. The remote's keys reach the page as plain
 * arrow and Enter key events; Android Back never does (MainActivity finishes
 * on it), which is why OK doubles as the way out.
 */
export function TvApp() {
  const { snapshot, stream, error } = useDashboard();
  const clock = useClock();
  useTvStage();

  useEffect(() => {
    const timer = setTimeout(() => window.location.reload(), SOFT_RELOAD_MS);
    return () => clearTimeout(timer);
  }, []);

  // Derived before the loading return so the D-pad hooks below may run
  // unconditionally; everything is empty until the snapshot lands.
  const dashboard = snapshot?.dashboard;
  const room = new URLSearchParams(window.location.search).get('room');
  const rooms = dashboard?.tv?.rooms ?? {};
  const preset: TvRoom | null = (room ? rooms[room] : null) ?? rooms['default'] ?? null;

  const cameraPanel = dashboard?.panels.find((panel) => panel.type === 'cameras');
  const cameras =
    cameraPanel === undefined
      ? []
      : preset?.cameras
        ? cameraPanel.cameras.filter((camera) => preset.cameras?.includes(camera.name))
        : cameraPanel.cameras;
  const cameraCount = cameras.length;

  // null = ring hidden: the page is an ambient display until a key arrives.
  const [focus, setFocus] = useState<number | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (cameraCount === 0) return;
    const last = cameraCount - 1;
    const onKeyDown = (event: KeyboardEvent) => {
      // Some remotes send OK as keyCode 13 with a nonstandard key value.
      const key = event.keyCode === 13 ? 'Enter' : event.key;
      if (viewing !== null) {
        if (key !== 'Enter' && key !== 'Escape' && !key.startsWith('Arrow')) return;
        event.preventDefault();
        if (key === 'Enter' || key === 'Escape') setViewing(null);
        return;
      }
      if (key === 'Enter') {
        // The first OK only reveals the ring; opening a camera sight unseen
        // would make every stray button press a jump cut.
        if (focus === null) setFocus(0);
        else setViewing(Math.min(focus, last));
      } else if (key === 'ArrowRight' || key === 'ArrowDown') {
        setFocus(focus === null ? 0 : Math.min(focus + 1, last));
      } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
        setFocus(focus === null ? 0 : Math.max(focus - 1, 0));
      } else {
        return;
      }
      event.preventDefault();
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setFocus(null), RING_HIDE_MS);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cameraCount, viewing, focus]);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  if (!snapshot || !dashboard) {
    return (
      <main className="shell tv">
        <div className="placeholder">{error ? <p className="text-alert">{error}</p> : <p>Loading…</p>}</div>
      </main>
    );
  }

  const { entities, sources } = snapshot;

  // A room preset that shrank the camera list out from under the ring.
  const safeFocus = focus === null ? null : Math.min(focus, cameraCount - 1);

  const railPanels = dashboard.panels.filter((panel) =>
    preset?.panels ? preset.panels.includes(panel.id) : LOOK_ONLY_TYPES.has(panel.type),
  );
  // Dealt into fixed roles: the ADS-B feed is the map under the photos,
  // system/ups/uptime collapse into chips in the top bar, and anything else
  // (entities, storage - fallback mode mostly) rails beside the map.
  const adsbPanel = railPanels.find((panel): panel is Extract<Panel, { type: 'adsb' }> => panel.type === 'adsb');
  const systemPanel = railPanels.find((panel): panel is Extract<Panel, { type: 'system' }> => panel.type === 'system');
  const upsPanel = railPanels.find((panel): panel is Extract<Panel, { type: 'ups' }> => panel.type === 'ups');
  const hasKuma = railPanels.some((panel) => panel.type === 'service' && panel.service === 'uptimeKuma');
  const otherPanels = railPanels.filter((panel) => panel.type === 'entities');

  const slideshow = dashboard.tv?.slideshow;
  const hasCameras = cameraPanel !== undefined && cameras.length > 0;

  const renderPanel = (panel: Panel) => {
    if (panel.type === 'entities') {
      return panel.chart === 'disk' ? (
        <StoragePanel
          key={panel.id}
          title={panel.title}
          refs={panel.entities}
          entities={entities}
          frigate={sources.frigate}
        />
      ) : (
        <EntitiesPanel key={panel.id} title={panel.title} refs={panel.entities} entities={entities} />
      );
    }
    return null;
  };

  return (
    <main className="shell tv">
      <header className="topbar">
        <div className="topbar__brand">
          <h1>{dashboard.title}</h1>
          <div className="topbar__status">
            <span className={`pill pill--${stream}`}>
              <span className="pill__dot" aria-hidden="true" />
              {STREAM_LABEL[stream] ?? stream}
            </span>
          </div>
        </div>
        {systemPanel || upsPanel || hasKuma ? (
          <TvStatusBar
            systemMetrics={systemPanel?.metrics}
            upsRefs={upsPanel?.entities}
            kuma={hasKuma ? sources.uptimeKuma : undefined}
            entities={entities}
          />
        ) : null}
        <span className="topbar__meta topbar__meta--outdoor">
          {dashboard.outdoor ? (
            <>
              {formatState(entities[dashboard.outdoor.temperature])} ·{' '}
              {formatState(entities[dashboard.outdoor.humidity])} ·{' '}
            </>
          ) : null}
          <span className="tv-clock">{clock}</span>
        </span>
      </header>

      {/* Cameras stack down the left; photos own the rest, with the flight map
          (and any railed panels) in a short strip beneath them. */}
      <div className={hasCameras ? 'tv-layout' : 'tv-layout tv-layout--no-cameras'}>
        {hasCameras && cameraPanel ? (
          <div className="tv-cameras">
            <CamerasPanel
              title={cameraPanel.title}
              cameras={cameras}
              refreshSeconds={cameraPanel.refreshSeconds ?? 5}
              stillHeight={360}
              frigate={sources.frigate}
              focusedIndex={safeFocus}
            />
          </div>
        ) : null}

        {slideshow ? <TvSlideshow seconds={slideshow.seconds ?? 20} /> : null}

        {adsbPanel || otherPanels.length > 0 ? (
          <div className={slideshow ? 'tv-strip' : 'tv-strip tv-strip--tall'}>
            {adsbPanel ? <TvAdsbMap title={adsbPanel.title} refreshSeconds={adsbPanel.refreshSeconds ?? 8} /> : null}
            {otherPanels.length > 0 ? <div className="tv-rail">{otherPanels.map(renderPanel)}</div> : null}
          </div>
        ) : null}
      </div>

      {viewing !== null && cameras[viewing] ? (
        <CameraViewer camera={cameras[viewing]} allowFullscreen={false} onClose={() => setViewing(null)} />
      ) : null}
    </main>
  );
}
