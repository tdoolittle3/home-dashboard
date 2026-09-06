import { CamerasPanel } from './components/CamerasPanel';
import { ControlsPanel } from './components/ControlsPanel';
import { EntitiesPanel } from './components/EntitiesPanel';
import { MediaPanel } from './components/MediaPanel';
import { PhotosPanel } from './components/PhotosPanel';
import { ServicesPanel } from './components/ServicesPanel';
import { StoragePanel } from './components/StoragePanel';
import { UptimePanel } from './components/UptimePanel';
import { formatRelative } from './format';
import type { Panel } from './types';
import { useDashboard } from './useDashboard';

const STREAM_LABEL: Record<string, string> = {
  connecting: 'connecting',
  live: 'live',
  offline: 'reconnecting',
};

export function App() {
  const { snapshot, stream, error, reload } = useDashboard();

  if (!snapshot) {
    return (
      <main className="shell">
        <div className="placeholder">
          {error ? (
            <>
              <p className="text-alert">{error}</p>
              <button type="button" className="toggle" onClick={reload}>
                Retry
              </button>
            </>
          ) : (
            <p>Loading…</p>
          )}
        </div>
      </main>
    );
  }

  const { dashboard, entities, sources, ha } = snapshot;

  // Cameras lead the page in a full-width row of their own. Below it the page
  // splits into a wide main column (storage and any other entity panels) and a
  // narrower side stack (controls, then services), each in the order
  // config/dashboard.json lists them. The side stack comes first in the DOM so
  // that on a phone, where the columns collapse, the switches sit right under
  // the cameras instead of below the charts.
  const cameraPanels = dashboard.panels.filter((panel) => panel.type === 'cameras');
  const sidePanels = dashboard.panels.filter((panel) => panel.type === 'controls');
  const mainPanels = dashboard.panels.filter((panel) => panel.type !== 'cameras' && panel.type !== 'controls');

  const renderPanel = (panel: Panel) => {
    if (panel.type === 'cameras') {
      return (
        <CamerasPanel
          key={panel.id}
          title={panel.title}
          cameras={panel.cameras}
          refreshSeconds={panel.refreshSeconds ?? 5}
          stillHeight={540}
        />
      );
    }
    if (panel.type === 'controls') {
      return <ControlsPanel key={panel.id} title={panel.title} refs={panel.entities} entities={entities} />;
    }
    if (panel.type === 'service') {
      switch (panel.service) {
        case 'uptimeKuma':
          return <UptimePanel key={panel.id} title={panel.title} result={sources.uptimeKuma} />;
        case 'jellyfin':
          return <MediaPanel key={panel.id} title={panel.title} result={sources.jellyfin} />;
        case 'immich':
          return <PhotosPanel key={panel.id} title={panel.title} result={sources.immich} />;
      }
    }
    if (panel.chart === 'disk') {
      return (
        <StoragePanel
          key={panel.id}
          title={panel.title}
          refs={panel.entities}
          entities={entities}
          frigate={sources.frigate}
        />
      );
    }
    return <EntitiesPanel key={panel.id} title={panel.title} refs={panel.entities} entities={entities} />;
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div className="topbar__brand">
          <h1>{dashboard.title}</h1>
          <div className="topbar__status">
            <span className={`pill pill--${stream}`}>
              <span className="pill__dot" aria-hidden="true" />
              {STREAM_LABEL[stream] ?? stream}
            </span>
            <span className="topbar__meta">updated {formatRelative(snapshot.generatedAt)}</span>
          </div>
        </div>
        <nav className="topbar__links" aria-label="Open a service">
          {dashboard.links.map((link) => (
            <a key={link.url} className="chip" href={link.url} target="_blank" rel="noreferrer">
              {link.label}
              <span className="chip__arrow" aria-hidden="true">
                ↗
              </span>
            </a>
          ))}
        </nav>
      </header>

      {cameraPanels.length > 0 ? <div className="hero">{cameraPanels.map(renderPanel)}</div> : null}

      <div className={mainPanels.length > 0 ? 'layout' : 'layout layout--single'}>
        <div className="layout__side">
          {sidePanels.map(renderPanel)}
          <ServicesPanel ha={ha} sources={sources} />
        </div>
        {mainPanels.length > 0 ? <div className="layout__main">{mainPanels.map(renderPanel)}</div> : null}
      </div>
    </main>
  );
}
