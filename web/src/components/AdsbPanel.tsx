import { useEffect, useMemo, useRef, useState } from 'react';
import { formatNumber } from '../format';
import { Panel } from './Panel';

interface AdsbPanelProps {
  title: string;
  /** Host[:port] of tar1090; the iframe, the poll and the full-map link all build on it. */
  baseHost: string;
  refreshSeconds: number;
}

/** One entry of tar1090's aircraft.json. Everything beyond hex is optional. */
interface Aircraft {
  hex: string;
  flight?: string;
  /** Registration and airframe type, present when the aircraft db knows the hex. */
  r?: string;
  t?: string;
  category?: string;
  /** Feet, or the literal string "ground". */
  alt_baro?: number | 'ground';
  alt_geom?: number;
  /** Ground speed, knots. */
  gs?: number;
  lat?: number;
  lon?: number;
  squawk?: string;
  /** Seconds since the receiver last heard this aircraft. */
  seen?: number;
  rssi?: number;
  /** readsb db flags; bit 0 is "military". */
  dbFlags?: number;
}

interface AircraftFeed {
  aircraft?: Aircraft[];
}

interface Receiver {
  lat?: number;
  lon?: number;
}

const TABLE_ROWS = 14;
/** Aircraft not heard from in this long stay on tar1090's map but drop from the table. */
const STALE_SECONDS = 60;

const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);
/** "Low & close": likely approach/departure traffic right overhead. */
const LOW_FT = 5000;
const CLOSE_KM = 8;

/**
 * Military is best-effort. The db flag is authoritative when the aircraft db
 * knows the hex; the callsign prefixes and type codes catch the common US
 * traffic it misses. category A7 (rotorcraft) is deliberately included per the
 * house rule, so expect medevac helicopters to wear the badge too.
 */
const MIL_CALLSIGN = /^(RCH|PAT|EVAC|SAM|CNV|NAVY|ARMY|GRIM|HOBO|DOOM|KING|TREK)/;
const MIL_TYPES = new Set([
  'A10', 'B1', 'B2', 'B52', 'C17', 'C130', 'C30J', 'C5M', 'E3TF', 'E6',
  'F15', 'F16', 'F18', 'F22', 'F35', 'K35R', 'KC46', 'P8', 'T38', 'U2', 'V22',
]);

const EARTH_RADIUS_KM = 6371;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = ((lat2 - lat1) * rad) / 2;
  const dLon = ((lon2 - lon1) * rad) / 2;
  const a = Math.sin(dLat) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** What the row is called: callsign, else registration, else the bare hex. */
function callsign(a: Aircraft): string {
  return a.flight?.trim() || a.r?.trim() || a.hex.toUpperCase();
}

function altitudeFt(a: Aircraft): number | 'ground' | null {
  if (a.alt_baro === 'ground') return 'ground';
  if (typeof a.alt_baro === 'number') return a.alt_baro;
  return typeof a.alt_geom === 'number' ? a.alt_geom : null;
}

function isMilitary(a: Aircraft): boolean {
  if (typeof a.dbFlags === 'number' && (a.dbFlags & 1) !== 0) return true;
  if (a.category === 'A7') return true;
  if (a.t && MIL_TYPES.has(a.t.toUpperCase())) return true;
  return MIL_CALLSIGN.test(a.flight?.trim().toUpperCase() ?? '');
}

interface Badge {
  label: string;
  tone: 'emergency' | 'military' | 'low' | 'stat';
}

interface Row {
  aircraft: Aircraft;
  distanceKm: number | null;
  badges: Badge[];
}

/**
 * Live local air traffic from the ADS-B receiver. The tar1090 map is embedded
 * as-is - it is already the best view of the sky - and the table under it is
 * the glanceable summary: who is overhead right now, and is any of it unusual.
 * The browser polls the receiver directly over Tailscale; the dashboard server
 * is not involved, so the panel carries its own offline state.
 */
export function AdsbPanel({ title, baseHost, refreshSeconds }: AdsbPanelProps) {
  const mapUrl = `http://${baseHost}/`;

  const [aircraft, setAircraft] = useState<Aircraft[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [receiver, setReceiver] = useState<Receiver | null>(null);
  // A ref, not state: the poll loop reads it without wanting to re-arm itself.
  const receiverRef = useRef<Receiver | null>(null);

  useEffect(() => {
    let alive = true;

    const pull = async () => {
      // A hidden tab keeps the interval but skips the work; stale rows are
      // recomputed the moment the next visible tick lands.
      if (document.hidden) return;

      // The receiver's own position gates the distance column; retry until it
      // answers - it 404s on builds that do not publish their location.
      if (!receiverRef.current) {
        try {
          const response = await fetch(`http://${baseHost}/data/receiver.json`);
          if (response.ok) {
            const body = (await response.json()) as Receiver;
            if (typeof body.lat === 'number' && typeof body.lon === 'number') {
              receiverRef.current = { lat: body.lat, lon: body.lon };
              if (alive) setReceiver(receiverRef.current);
            } else {
              // Answered without a position: it never will, stop asking.
              receiverRef.current = {};
            }
          }
        } catch {
          /* same outage the aircraft fetch is about to report */
        }
      }

      try {
        const response = await fetch(`http://${baseHost}/data/aircraft.json`);
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as AircraftFeed;
        if (!alive) return;
        setAircraft(Array.isArray(body.aircraft) ? body.aircraft : []);
        setOffline(false);
      } catch {
        // The SDR dongle gets borrowed by other tools; that is a state to
        // show, not an error to throw.
        if (alive) setOffline(true);
      }
    };

    void pull();
    const timer = setInterval(() => void pull(), refreshSeconds * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [baseHost, refreshSeconds]);

  const tracked = aircraft?.length ?? 0;
  const withPosition = aircraft?.filter((a) => typeof a.lat === 'number' && typeof a.lon === 'number').length ?? 0;

  const rows = useMemo<Row[]>(() => {
    if (!aircraft) return [];
    const recent = aircraft
      .filter((a) => (a.seen ?? Number.POSITIVE_INFINITY) <= STALE_SECONDS)
      .sort((a, b) => (a.seen ?? Number.POSITIVE_INFINITY) - (b.seen ?? Number.POSITIVE_INFINITY))
      .slice(0, TABLE_ROWS);

    const home = receiver;
    const rows: Row[] = recent.map((a) => ({
      aircraft: a,
      distanceKm:
        home && typeof home.lat === 'number' && typeof home.lon === 'number' && typeof a.lat === 'number' && typeof a.lon === 'number'
          ? haversineKm(home.lat, home.lon, a.lat, a.lon)
          : null,
      badges: [],
    }));

    // Fastest and highest are relative claims; with one aircraft in view they
    // say nothing, so they only appear once there is company.
    let fastest: Row | null = null;
    let highest: Row | null = null;
    if (rows.length >= 2) {
      for (const row of rows) {
        const alt = altitudeFt(row.aircraft);
        if ((row.aircraft.gs ?? 0) > 0 && (fastest === null || (row.aircraft.gs ?? 0) > (fastest.aircraft.gs ?? 0))) fastest = row;
        if (typeof alt === 'number' && (highest === null || alt > (altitudeFt(highest.aircraft) as number))) highest = row;
      }
    }

    for (const row of rows) {
      const a = row.aircraft;
      const alt = altitudeFt(a);
      if (a.squawk && EMERGENCY_SQUAWKS.has(a.squawk)) row.badges.push({ label: `squawk ${a.squawk}`, tone: 'emergency' });
      if (isMilitary(a)) row.badges.push({ label: 'mil', tone: 'military' });
      if (typeof alt === 'number' && alt < LOW_FT && row.distanceKm !== null && row.distanceKm < CLOSE_KM) {
        row.badges.push({ label: 'low & close', tone: 'low' });
      }
      if (row === fastest) row.badges.push({ label: 'fastest', tone: 'stat' });
      if (row === highest) row.badges.push({ label: 'highest', tone: 'stat' });
    }
    return rows;
  }, [aircraft, receiver]);

  const aside = (
    <>
      {offline ? 'receiver offline' : aircraft ? `${tracked} tracked · ${withPosition} with position` : null}
      <a className="adsb__open" href={mapUrl} target="_blank" rel="noreferrer">
        Open full map ↗
      </a>
    </>
  );

  return (
    <Panel title={title} aside={aside}>
      <div className="adsb">
        <iframe
          className="adsb__map"
          src={mapUrl}
          title="Live ADS-B map (tar1090)"
          loading="lazy"
          allowFullScreen
          allow="fullscreen"
        />

        {offline ? (
          <p className="empty">
            Receiver offline or no data - the SDR service may be stopped. Retrying every {refreshSeconds}s.
          </p>
        ) : !aircraft ? (
          <p className="empty">Waiting for aircraft data…</p>
        ) : rows.length === 0 ? (
          <p className="empty">Nothing in range right now.</p>
        ) : (
          <div className="adsb__scroll">
            <table className="adsb__table">
              <thead>
                <tr>
                  <th>Flight</th>
                  <th className="adsb__optional">Type</th>
                  <th>Alt ft</th>
                  <th>Spd kt</th>
                  <th>Dist km</th>
                  <th className="adsb__optional">Sig dBm</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ aircraft: a, distanceKm, badges }) => {
                  const alt = altitudeFt(a);
                  return (
                    <tr key={a.hex}>
                      <td>
                        <a
                          className="adsb__flight"
                          href={`https://globe.adsbexchange.com/?icao=${encodeURIComponent(a.hex)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {callsign(a)}
                        </a>
                        {badges.map((badge) => (
                          <span key={badge.label} className={`badge badge--${badge.tone}`}>
                            {badge.label}
                          </span>
                        ))}
                      </td>
                      <td className="adsb__optional">{a.t ?? '—'}</td>
                      <td>{alt === null ? '—' : alt === 'ground' ? 'ground' : formatNumber(alt)}</td>
                      <td>{typeof a.gs === 'number' ? Math.round(a.gs) : '—'}</td>
                      <td>{distanceKm === null ? '—' : formatNumber(distanceKm)}</td>
                      <td className="adsb__optional">{typeof a.rssi === 'number' ? a.rssi.toFixed(1) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}
