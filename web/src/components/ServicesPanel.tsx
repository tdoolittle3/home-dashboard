import { formatEpoch, formatNumber, formatUptime } from '../format';
import type { HaStatus, SourcesSnapshot } from '../types';
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
