import type { ReactNode } from 'react';
import { formatBytes, formatNumber, formatUptime } from '../format';
import type { HaStatus, LinkHealth, ServiceLink, SourcesSnapshot, TileService } from '../types';
import { Panel } from './Panel';

interface ServicesPanelProps {
  ha: HaStatus;
  sources: SourcesSnapshot;
  links: ServiceLink[];
}

interface TileProps {
  name: string;
  /** null means the service is not configured / not pinged - a resting state, not a fault. */
  ok: boolean | null;
  detail: string;
  note?: string;
  /** With a url the whole tile is the way in; the panel is the launcher now. */
  href?: string;
}

function Tile({ name, ok, detail, note, href }: TileProps) {
  const state = ok === null ? 'idle' : ok ? 'up' : 'down';
  const body: ReactNode = (
    <>
      <div className="tile__head">
        <span className={`tile__dot tile__dot--${state}`} aria-hidden="true" />
        <span className="tile__name">{name}</span>
        {href ? (
          <span className="tile__arrow" aria-hidden="true">
            ↗
          </span>
        ) : null}
      </div>
      <div className="tile__detail">{detail}</div>
      {note ? <div className="tile__note">{note}</div> : null}
    </>
  );

  if (href) {
    return (
      <a className={`tile tile--link tile--${state}`} href={href} target="_blank" rel="noreferrer">
        {body}
      </a>
    );
  }
  return <div className={`tile tile--${state}`}>{body}</div>;
}

const NOT_CONFIGURED = 'Not configured';

/**
 * The Services panel is both status board and launcher: every tile links to the
 * service it reports on (the topbar carries no links anymore). The five
 * built-in tiles read their own pollers; the generic tiles are config links,
 * with a dot when the server pings their health url.
 */
export function ServicesPanel({ ha, sources, links }: ServicesPanelProps) {
  const { frigate, jellyfin, uptimeKuma, immich, linkHealth } = sources;

  const urlFor = (service: TileService): string | undefined =>
    links.find((link) => link.service === service)?.url;

  const health = new Map<string, LinkHealth>(
    linkHealth?.ok ? linkHealth.data.map((entry) => [entry.label, entry]) : [],
  );
  const genericLinks = links.filter((link) => link.service === undefined);

  const frigateDetail = frigate?.ok
    ? `${frigate.data.cameras.length} cameras · up ${formatUptime(frigate.data.uptimeSeconds)}`
    : (frigate?.error ?? NOT_CONFIGURED);

  const detector = frigate?.ok ? frigate.data.detectors[0] : undefined;

  const jellyfinDetail = jellyfin?.ok
    ? jellyfin.data.playing > 0
      ? `${jellyfin.data.playing} playing · ${jellyfin.data.sessions.length} client${jellyfin.data.sessions.length === 1 ? '' : 's'}`
      : `idle · ${jellyfin.data.sessions.length} client${jellyfin.data.sessions.length === 1 ? '' : 's'}`
    : (jellyfin?.error ?? NOT_CONFIGURED);

  const kumaDetail = uptimeKuma?.ok
    ? uptimeKuma.data.monitors.length === 0
      ? 'No monitors configured'
      : `${uptimeKuma.data.up} up · ${uptimeKuma.data.down} down`
    : (uptimeKuma?.error ?? NOT_CONFIGURED);

  const immichDetail = immich?.ok
    ? immich.data.library
      ? `${formatNumber(immich.data.library.photos + immich.data.library.videos)} items · ${formatBytes(immich.data.library.usageBytes)}`
      : (immich.data.version ?? 'connected')
    : (immich?.error ?? NOT_CONFIGURED);

  const immichJobs = immich?.ok ? immich.data.jobs : null;

  return (
    <Panel title="Services">
      <div className="tiles">
        <Tile
          name="Home Assistant"
          ok={ha.connected}
          detail={ha.connected ? (ha.version ?? 'connected') : (ha.lastError ?? 'disconnected')}
          {...(ha.authFailed ? { note: 'token rejected - replace HA_TOKEN' } : {})}
          {...(urlFor('ha') ? { href: urlFor('ha') } : {})}
        />
        <Tile
          name="Frigate"
          ok={frigate ? frigate.ok : null}
          detail={frigateDetail}
          {...(detector?.inferenceSpeedMs != null
            ? { note: `${detector.name} ${formatNumber(detector.inferenceSpeedMs)} ms` }
            : {})}
          {...(urlFor('frigate') ? { href: urlFor('frigate') } : {})}
        />
        <Tile
          name="Jellyfin"
          ok={jellyfin ? jellyfin.ok : null}
          detail={jellyfinDetail}
          {...(urlFor('jellyfin') ? { href: urlFor('jellyfin') } : {})}
        />
        <Tile
          name="Uptime Kuma"
          ok={uptimeKuma ? uptimeKuma.ok : null}
          detail={kumaDetail}
          {...(urlFor('uptimeKuma') ? { href: urlFor('uptimeKuma') } : {})}
        />
        <Tile
          name="Immich"
          ok={immich ? immich.ok : null}
          detail={immichDetail}
          {...(immichJobs && immichJobs.active + immichJobs.waiting > 0
            ? { note: `${formatNumber(immichJobs.active)} jobs running · ${formatNumber(immichJobs.waiting)} queued` }
            : {})}
          {...(urlFor('immich') ? { href: urlFor('immich') } : {})}
        />
        {genericLinks.map((link) => {
          const ping = link.health ? health.get(link.label) : undefined;
          // Pinged and answering: how fast. Pinged and silent: why not. Not
          // pinged: at least say where the tile goes.
          const detail = ping
            ? ping.up
              ? `up${ping.latencyMs === null ? '' : ` · ${formatNumber(ping.latencyMs)} ms`}`
              : (ping.error ?? 'unreachable')
            : new URL(link.url).host;
          return (
            <Tile
              key={link.label}
              name={link.label}
              ok={link.health ? (ping ? ping.up : null) : null}
              detail={detail}
              {...(ping?.up && ping.status !== null && ping.status >= 400 ? { note: `HTTP ${ping.status}` } : {})}
              href={link.url}
            />
          );
        })}
      </div>

    </Panel>
  );
}
