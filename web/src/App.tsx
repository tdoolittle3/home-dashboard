import { CamerasPanel } from './components/CamerasPanel';
import { ControlsPanel } from './components/ControlsPanel';
import { EntitiesPanel } from './components/EntitiesPanel';
import { ServicesPanel } from './components/ServicesPanel';
import { StoragePanel } from './components/StoragePanel';
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

  // Cameras lead the page in a full-width row of their own; everything else
  // follows in the grid, in the order config/dashboard.json lists it.
  const cameraPanels = dashboard.panels.filter((panel) => panel.type === 'cameras');
  const restPanels = dashboard.panels.filter((panel) => panel.type !== 'cameras');

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
        <h1>{dashboard.title}</h1>
        <div className="topbar__status">
          <span className={`pill pill--${stream}`}>{STREAM_LABEL[stream] ?? stream}</span>
          <span className="topbar__meta">updated {formatRelative(snapshot.generatedAt)}</span>
        </div>
        <nav className="topbar__links">
          {dashboard.links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
              {link.label}
            </a>
          ))}
        </nav>
      </header>

      {cameraPanels.length > 0 ? <div className="hero">{cameraPanels.map(renderPanel)}</div> : null}

      <div className="grid">
        {restPanels.map(renderPanel)}
        <ServicesPanel ha={ha} sources={sources} />
      </div>
    </main>
  );
}
