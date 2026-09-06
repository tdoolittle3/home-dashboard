import { formatEpoch, formatMb, formatNumber, formatUptime } from '../format';
import type { FrigateSummary, HaStatus, SourcesSnapshot } from '../types';
import { DiskPie } from './DiskPie';
import { Panel } from './Panel';

interface ServicesPanelProps {
  ha: HaStatus;
  sources: SourcesSnapshot;
}

function Tile({ name, ok, detail, note }: { name: string; ok: boolean | null; detail: string; note?: string }) {
  const status = ok === null ? 'tile__dot--idle' : ok ? 'tile__dot--up' : 'tile__dot--down';
  return (
    <div className="tile">
      <div className="tile__head">
        <span className={`tile__dot ${status}`} aria-hidden="true" />
        <span className="tile__name">{name}</span>
      </div>
      <div className="tile__detail">{detail}</div>
      {note ? <div className="tile__note">{note}</div> : null}
    </div>
  );
}

interface MountGroup {
  mount: string;
  alsoServes: string[];
  totalMb: number | null;
  usedMb: number | null;
  freeMb: number | null;
}

type SizedMountGroup = MountGroup & { totalMb: number; usedMb: number; freeMb: number };

/**
 * Frigate reports one row per configured path, so several paths on one
 * filesystem come back with identical figures - on this host `recordings` and
 * `clips` are the same disk. Group by those figures so the same drive is not
 * drawn twice.
 */
function groupMounts(storage: FrigateSummary['storage']): MountGroup[] {
  const groups = new Map<string, MountGroup>();

  for (const entry of storage) {
    const key = `${entry.totalMb}|${entry.usedMb}|${entry.freeMb}`;
    const existing = groups.get(key);
    if (existing) {
      existing.alsoServes.push(entry.mount);
    } else {
      groups.set(key, {
        mount: entry.mount,
        alsoServes: [],
        totalMb: entry.totalMb,
        usedMb: entry.usedMb,
        freeMb: entry.freeMb,
      });
    }
  }

  return [...groups.values()];
}

function hasSizes(group: MountGroup): group is SizedMountGroup {
  return group.totalMb !== null && group.usedMb !== null && group.freeMb !== null && group.totalMb > 0;
}

export function ServicesPanel({ ha, sources }: ServicesPanelProps) {
  const { frigate, jellyfin, uptimeKuma } = sources;

  const frigateDetail = frigate?.ok
    ? `${frigate.data.cameras.length} cameras - up ${formatUptime(frigate.data.uptimeSeconds)}`
    : (frigate?.error ?? 'not configured');

  const detector = frigate?.ok ? frigate.data.detectors[0] : undefined;

  const jellyfinDetail = jellyfin?.ok
    ? `${jellyfin.data.sessions.length} session${jellyfin.data.sessions.length === 1 ? '' : 's'}`
    : (jellyfin?.error ?? 'not configured');

  const kumaDetail = uptimeKuma?.ok
    ? uptimeKuma.data.monitors.length === 0
      ? 'no monitors configured'
      : `${uptimeKuma.data.up} up / ${uptimeKuma.data.down} down`
    : (uptimeKuma?.error ?? 'not configured');

  // The hard drive is the largest filesystem Frigate reports; the remainder are
  // small tmpfs mounts that say more as a line of text than as a chart.
  const mountGroups = frigate?.ok ? groupMounts(frigate.data.storage) : [];
  const disk = mountGroups.filter(hasSizes).sort((a, b) => b.totalMb - a.totalMb)[0];
  const otherMounts = mountGroups.filter((group) => group !== disk);

  return (
    <Panel title="Services">
      <div className="tiles">
        <Tile
          name="Home Assistant"
          ok={ha.connected}
          detail={ha.connected ? (ha.version ?? 'connected') : (ha.lastError ?? 'disconnected')}
          {...(ha.authFailed ? { note: 'token rejected - replace HA_TOKEN' } : {})}
        />
        <Tile
          name="Frigate"
          ok={frigate ? frigate.ok : null}
          detail={frigateDetail}
          {...(detector?.inferenceSpeedMs != null
            ? { note: `${detector.name} ${formatNumber(detector.inferenceSpeedMs)} ms` }
            : {})}
        />
        <Tile name="Jellyfin" ok={jellyfin ? jellyfin.ok : null} detail={jellyfinDetail} />
        <Tile name="Uptime Kuma" ok={uptimeKuma ? uptimeKuma.ok : null} detail={kumaDetail} />
      </div>

      {disk ? (
        <>
          <h3 className="subhead">Hard drive</h3>
          <DiskPie
            mount={disk.mount}
            alsoServes={disk.alsoServes}
            totalMb={disk.totalMb}
            usedMb={disk.usedMb}
            freeMb={disk.freeMb}
          />
        </>
      ) : null}

      {otherMounts.length > 0 ? (
        <ul className="rows rows--tight">
          {otherMounts.map((group) => (
            <li key={group.mount} className="row">
              <span className="row__label">{[group.mount, ...group.alsoServes].join(', ')}</span>
              <span className="row__value">{formatMb(group.usedMb)} used</span>
              <span className="row__meta">{formatMb(group.freeMb)} free</span>
            </li>
          ))}
        </ul>
      ) : null}

      {frigate?.ok && frigate.data.recentEvents.length > 0 ? (
        <>
          <h3 className="subhead">Recent detections</h3>
          <ul className="rows rows--tight">
            {frigate.data.recentEvents.slice(0, 5).map((event) => (
              <li key={event.id} className="row">
                <span className="row__label">
                  {event.label} - {event.camera}
                </span>
                <span className="row__value">
                  {event.score === null ? '' : `${Math.round(event.score * 100)}%`}
                </span>
                <span className="row__meta">{formatEpoch(event.startTime)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {jellyfin?.ok && jellyfin.data.sessions.length > 0 ? (
        <>
          <h3 className="subhead">Now playing</h3>
          <ul className="rows rows--tight">
            {jellyfin.data.sessions.map((session, index) => (
              <li key={`${session.user ?? 'user'}-${index}`} className="row">
                <span className="row__label">{session.nowPlaying ?? 'idle'}</span>
                <span className="row__value">{session.user ?? ''}</span>
                <span className="row__meta">{session.paused ? 'paused' : (session.client ?? '')}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Panel>
  );
}
