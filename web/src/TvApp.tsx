import { useEffect, useState } from 'react';
import { CamerasPanel } from './components/CamerasPanel';
import { ControlsPanel } from './components/ControlsPanel';
import { EntitiesPanel } from './components/EntitiesPanel';
import { StoragePanel } from './components/StoragePanel';
import { SystemPanel } from './components/SystemPanel';
import { TvSlideshow } from './components/TvSlideshow';
import { UpsPanel } from './components/UpsPanel';
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

/** Panel types that never write - the only ones a /tv room may show. */
const LOOK_ONLY_TYPES = new Set(['entities', 'controls', 'system', 'ups']);

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(interval);
  }, []);
  return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * The look-only page the Fire TV shows (tv-app/ wraps it in a WebView).
 * Reuses the dashboard's own panels; a blanket pointer-events: none in the
 * .tv styles is what makes them inert, not forked components. ?room=<name>
 * picks a preset from dashboard.json's tv.rooms; no match falls back to the
 * room named "default", then to everything.
 */
export function TvApp() {
  const { snapshot, stream, error } = useDashboard();
  const clock = useClock();

  useEffect(() => {
    const timer = setTimeout(() => window.location.reload(), SOFT_RELOAD_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!snapshot) {
    return (
      <main className="shell tv">
        <div className="placeholder">{error ? <p className="text-alert">{error}</p> : <p>Loading…</p>}</div>
      </main>
    );
  }

  const { dashboard, entities, sources } = snapshot;
  const room = new URLSearchParams(window.location.search).get('room');
  const rooms = dashboard.tv?.rooms ?? {};
  const preset: TvRoom | null = (room ? rooms[room] : null) ?? rooms['default'] ?? null;

  const cameraPanel = dashboard.panels.find((panel) => panel.type === 'cameras');
  const cameras =
    cameraPanel === undefined
      ? []
      : preset?.cameras
        ? cameraPanel.cameras.filter((camera) => preset.cameras?.includes(camera.name))
        : cameraPanel.cameras;

  const railPanels = dashboard.panels.filter((panel) =>
    preset?.panels ? preset.panels.includes(panel.id) : LOOK_ONLY_TYPES.has(panel.type),
  );

  const slideshow = dashboard.tv?.slideshow;

  const renderPanel = (panel: Panel) => {
    if (panel.type === 'controls') {
      return (
        <ControlsPanel
          key={panel.id}
          title={panel.title}
          refs={panel.entities}
          lights={panel.lights}
          sensors={panel.sensors}
          entities={entities}
        />
      );
    }
    if (panel.type === 'system') {
      return <SystemPanel key={panel.id} title={panel.title} metrics={panel.metrics} entities={entities} />;
    }
    if (panel.type === 'ups') {
      return <UpsPanel key={panel.id} title={panel.title} refs={panel.entities} entities={entities} />;
    }
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

      {cameraPanel && cameras.length > 0 ? (
        <div className="hero">
          <CamerasPanel
            title={cameraPanel.title}
            cameras={cameras}
            refreshSeconds={cameraPanel.refreshSeconds ?? 5}
            stillHeight={720}
            frigate={sources.frigate}
          />
        </div>
      ) : null}

      <div className={slideshow ? 'tv-band' : 'tv-band tv-band--bare'}>
        {slideshow ? <TvSlideshow seconds={slideshow.seconds ?? 20} /> : null}
        <div className="tv-rail">{railPanels.map(renderPanel)}</div>
      </div>
    </main>
  );
}
