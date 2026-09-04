import { CamerasPanel } from './components/CamerasPanel';
import { ControlsPanel } from './components/ControlsPanel';
import { EntitiesPanel } from './components/EntitiesPanel';
import { ServicesPanel } from './components/ServicesPanel';
import { formatRelative } from './format';
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

      <div className="grid">
        <ServicesPanel ha={ha} sources={sources} />

        {dashboard.panels.map((panel) => {
          if (panel.type === 'cameras') {
            return (
              <CamerasPanel
                key={panel.id}
                title={panel.title}
                cameras={panel.cameras}
                refreshSeconds={panel.refreshSeconds ?? 5}
              />
            );
          }
          if (panel.type === 'controls') {
            return (
              <ControlsPanel key={panel.id} title={panel.title} refs={panel.entities} entities={entities} />
            );
          }
          return <EntitiesPanel key={panel.id} title={panel.title} refs={panel.entities} entities={entities} />;
        })}
      </div>
    </main>
  );
}
