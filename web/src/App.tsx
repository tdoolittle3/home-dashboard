import { AdsbPanel } from './components/AdsbPanel';
import { CamerasPanel } from './components/CamerasPanel';
import { ControlsPanel } from './components/ControlsPanel';
import { DnsPanel } from './components/DnsPanel';
import { EntitiesPanel } from './components/EntitiesPanel';
import { Masonry } from './components/Masonry';
import { MediaPanel } from './components/MediaPanel';
import { PhotosPanel } from './components/PhotosPanel';
import { ServicesPanel } from './components/ServicesPanel';
import { StoragePanel } from './components/StoragePanel';
import { SystemPanel } from './components/SystemPanel';
import { UpsPanel } from './components/UpsPanel';
import { UptimePanel } from './components/UptimePanel';
import { formatRelative } from './format';
import type { Panel } from './types';
import { useDashboard } from './useDashboard';
import { useMediaQuery } from './useMediaQuery';

const STREAM_LABEL: Record<string, string> = {
  connecting: 'connecting',
  live: 'live',
  offline: 'reconnecting',
};

export function App() {
  const { snapshot, stream, error, reload } = useDashboard();
  // Desktop widths deal the panels into balanced columns; below 901px the
  // single stacked column the phone layout was built around stays as it is.
  const desktop = useMediaQuery('(min-width: 901px)');
  const wide = useMediaQuery('(min-width: 1500px)');

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

  // Cameras lead the page in a full-width row of their own. Below it, on a
  // phone, the side stack (controls, then services) comes first so the switches
  // sit right under the cameras, then every other panel in the order
  // config/dashboard.json lists them. On a desktop the side stack heads the
  // last column and the rest are dealt into balanced columns in that order.
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
          frigate={sources.frigate}
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
        case 'adguard':
          return <DnsPanel key={panel.id} title={panel.title} result={sources.adguard} kuma={sources.uptimeKuma} />;
      }
    }
    if (panel.type === 'system') {
      return <SystemPanel key={panel.id} title={panel.title} metrics={panel.metrics} entities={entities} />;
    }
    if (panel.type === 'ups') {
      return <UpsPanel key={panel.id} title={panel.title} refs={panel.entities} entities={entities} />;
    }
    if (panel.type === 'adsb') {
      return (
        <AdsbPanel
          key={panel.id}
          title={panel.title}
          baseHost={panel.baseHost}
          refreshSeconds={panel.refreshSeconds ?? 8}
        />
      );
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
      </header>

      {cameraPanels.length > 0 ? <div className="hero">{cameraPanels.map(renderPanel)}</div> : null}

      {desktop ? (
        <Masonry
          columns={wide ? 3 : 2}
          pinned={
            <div className="layout__side">
              {sidePanels.map(renderPanel)}
              <ServicesPanel ha={ha} sources={sources} links={dashboard.links} />
            </div>
          }
          items={mainPanels.map((panel) => ({ key: panel.id, node: renderPanel(panel) }))}
        />
      ) : (
        <div className={mainPanels.length > 0 ? 'layout' : 'layout layout--single'}>
          <div className="layout__side">
            {sidePanels.map(renderPanel)}
            <ServicesPanel ha={ha} sources={sources} links={dashboard.links} />
          </div>
          {mainPanels.length > 0 ? <div className="layout__main">{mainPanels.map(renderPanel)}</div> : null}
        </div>
      )}
    </main>
  );
}
