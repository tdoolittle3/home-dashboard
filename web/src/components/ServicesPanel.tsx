import type { ReactNode } from 'react';
import { formatBytes, formatNumber, formatUptime } from '../format';
import type { HaStatus, LinkHealth, ServiceLink, SourcesSnapshot, TileService } from '../types';
import { Panel } from './Panel';
import { TileIcon } from './TileIcon';

interface ServicesPanelProps {
  ha: HaStatus;
  sources: SourcesSnapshot;
  links: ServiceLink[];
}

interface TileProps {
  name: string;
  icon: string;
  /** null means the service is not configured / not pinged - a resting state, not a fault. */
  ok: boolean | null;
  detail: string;
  note?: string;
  /** With a url the whole tile is the way in; the panel is the launcher now. */
  href?: string;
}

function Tile({ name, icon, ok, detail, note, href }: TileProps) {
  const state = ok === null ? 'idle' : ok ? 'up' : 'down';
  const body: ReactNode = (
    <>
      <div className="tile__head">
        <span className="tile__glyph">
          <TileIcon name={icon} />
          {/* Unmonitored tiles carry no badge: absence reads as "not watched", not "fine". */}
          {ok === null ? null : <span className={`tile__dot tile__dot--${state}`} aria-hidden="true" />}
        </span>
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

const BUILTIN_ICON: Record<TileService, string> = {
  ha: 'home',
  frigate: 'camera',
  jellyfin: 'play',
  uptimeKuma: 'pulse',
  immich: 'photo',
};

/**
 * The Services panel is both status board and launcher: every tile links to
 * the service it reports on (the topbar carries no links anymore). Tiles
 * follow config/dashboard.json's links order, grouped under each entry's
 * `group` label; ungrouped links - and the built-in tiles no link entry
 * claims, which still show their pollers' status - lead unlabelled. The five
 * built-ins read their own pollers; the generic tiles are config links, with
 * a dot when the server pings their health url.
 */
export function ServicesPanel({ ha, sources, links }: ServicesPanelProps) {
  const { frigate, jellyfin, uptimeKuma, immich, linkHealth } = sources;

  const health = new Map<string, LinkHealth>(
    linkHealth?.ok ? linkHealth.data.map((entry) => [entry.label, entry]) : [],
  );

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

  const builtinTile = (service: TileService, link?: ServiceLink): ReactNode => {
    const key = link?.label ?? service;
    const common = {
      icon: link?.icon ?? BUILTIN_ICON[service],
      ...(link ? { href: link.url } : {}),
    };
    switch (service) {
      case 'ha':
        return (
          <Tile
            key={key}
            {...common}
            name={link?.label ?? 'Home Assistant'}
            ok={ha.connected}
            detail={ha.connected ? (ha.version ?? 'connected') : (ha.lastError ?? 'disconnected')}
            {...(ha.authFailed ? { note: 'token rejected - replace HA_TOKEN' } : {})}
          />
        );
      case 'frigate':
        return (
          <Tile
            key={key}
            {...common}
            name={link?.label ?? 'Frigate'}
            ok={frigate ? frigate.ok : null}
            detail={frigateDetail}
            {...(detector?.inferenceSpeedMs != null
              ? { note: `${detector.name} ${formatNumber(detector.inferenceSpeedMs)} ms` }
              : {})}
          />
        );
      case 'jellyfin':
        return (
          <Tile key={key} {...common} name={link?.label ?? 'Jellyfin'} ok={jellyfin ? jellyfin.ok : null} detail={jellyfinDetail} />
        );
      case 'uptimeKuma':
        return (
          <Tile key={key} {...common} name={link?.label ?? 'Uptime Kuma'} ok={uptimeKuma ? uptimeKuma.ok : null} detail={kumaDetail} />
        );
      case 'immich':
        return (
          <Tile
            key={key}
            {...common}
            name={link?.label ?? 'Immich'}
            ok={immich ? immich.ok : null}
            detail={immichDetail}
            {...(immichJobs && immichJobs.active + immichJobs.waiting > 0
              ? { note: `${formatNumber(immichJobs.active)} jobs running · ${formatNumber(immichJobs.waiting)} queued` }
              : {})}
          />
        );
    }
  };

  const genericTile = (link: ServiceLink): ReactNode => {
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
        icon={link.icon ?? 'link'}
        ok={link.health ? (ping ? ping.up : null) : null}
        detail={detail}
        {...(ping?.up && ping.status !== null && ping.status >= 400 ? { note: `HTTP ${ping.status}` } : {})}
        href={link.url}
      />
    );
  };

  const tileFor = (link: ServiceLink): ReactNode =>
    link.service === undefined ? genericTile(link) : builtinTile(link.service, link);

  // Built-ins no link entry claims still show their status, leading the
  // unlabelled section; then config order, grouped. Group labels keep the
  // order the config first mentions them in, with ungrouped tiles up front.
  const claimed = new Set(links.map((link) => link.service).filter(Boolean));
  const orphanServices = (Object.keys(BUILTIN_ICON) as TileService[]).filter((service) => !claimed.has(service));

  const sections = new Map<string, ReactNode[]>([['', orphanServices.map((service) => builtinTile(service))]]);
  for (const link of links) {
    const name = link.group ?? '';
    const section = sections.get(name) ?? [];
    section.push(tileFor(link));
    sections.set(name, section);
  }

  return (
    <Panel title="Services">
      {[...sections].map(([name, tiles]) =>
        tiles.length === 0 ? null : (
          <section key={name || '(ungrouped)'} className="tilegroup">
            {name ? <h3 className="tilegroup__name">{name}</h3> : null}
            <div className="tiles">{tiles}</div>
          </section>
        ),
      )}
    </Panel>
  );
}
