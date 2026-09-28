import { useState } from 'react';
import { sendAction } from '../api';
import { formatRelative, formatState, isOn, isProblem, labelFor } from '../format';
import type { EntityRef, EntitySnapshot } from '../types';
import { Panel } from './Panel';

interface ControlsPanelProps {
  title: string;
  refs: EntityRef[];
  /** Lamp buttons drawn in this order, left to right, matching the room. */
  lights?: { name?: string; entities: EntityRef[] };
  /** Read-only door/leak status rows. */
  sensors?: EntityRef[];
  entities: Record<string, EntitySnapshot>;
}

/** How a read-only sensor row reads and colours, by device class. */
function senseReading(entity: EntitySnapshot | undefined): { text: string; tone: 'idle' | 'ok' | 'open' | 'alert' } {
  if (!entity || entity.missing || isProblem(entity)) return { text: formatState(entity), tone: 'idle' };
  const active = isOn(entity);
  if (entity.deviceClass === 'moisture') {
    return active ? { text: 'Leak', tone: 'alert' } : { text: 'Dry', tone: 'ok' };
  }
  if (entity.deviceClass === 'opening' || entity.deviceClass === 'door' || entity.deviceClass === 'window') {
    return active ? { text: 'Open', tone: 'open' } : { text: 'Closed', tone: 'ok' };
  }
  return { text: formatState(entity), tone: active ? 'open' : 'ok' };
}

/** A classic bulb: rays only exist while it is on. */
function LampGlyph({ on }: { on: boolean }) {
  return (
    <svg className="lamp__glyph" viewBox="0 0 40 44" aria-hidden="true">
      {on ? (
        <g className="lamp__rays">
          <line x1="20" y1="1.5" x2="20" y2="4.5" />
          <line x1="8.5" y1="6.5" x2="10.7" y2="8.7" />
          <line x1="31.5" y1="6.5" x2="29.3" y2="8.7" />
          <line x1="3.5" y1="18" x2="6.5" y2="18" />
          <line x1="36.5" y1="18" x2="33.5" y2="18" />
        </g>
      ) : null}
      <path
        className="lamp__bulb"
        d="M20 8a10 10 0 0 1 6.5 17.6c-1.5 1.3-2.5 2.7-2.5 4.4h-8c0-1.7-1-3.1-2.5-4.4A10 10 0 0 1 20 8Z"
      />
      <rect className="lamp__base" x="16" y="33" width="8" height="2.5" rx="1.25" />
      <rect className="lamp__base" x="17.5" y="38" width="5" height="2.5" rx="1.25" />
    </svg>
  );
}

export function ControlsPanel({ title, refs, lights, sensors, entities }: ControlsPanelProps) {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const mark = (ids: string[], busy: boolean): void => {
    setPending((current) => {
      const next = { ...current };
      for (const id of ids) next[id] = busy;
      return next;
    });
  };

  // No optimistic state: the switch reports back over the stream, and pretending
  // otherwise would lie about a camera light that failed to turn on.
  const act = async (ids: string[], action: 'turn_on' | 'turn_off' | 'toggle'): Promise<void> => {
    mark(ids, true);
    setError(null);
    try {
      await Promise.all(ids.map((id) => sendAction(id, action)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      mark(ids, false);
    }
  };

  const lightIds = (lights?.entities ?? []).map((ref) => ref.entity_id);
  const lightsBusy = lightIds.some((id) => pending[id] === true);
  const lightsReady = lightIds.some((id) => entities[id]?.missing === false);

  return (
    <Panel title={title} aside={error ? <span className="text-alert">{error}</span> : null}>
      <div className="controls">
        {lights ? (
          <div className="lamps">
            <div className="lamps__head">
              <span className="lamps__name">{lights.name ?? 'Lights'}</span>
              <div className="lamps__all">
                <button
                  type="button"
                  className="toggle toggle--small"
                  disabled={lightsBusy || !lightsReady}
                  onClick={() => void act(lightIds, 'turn_on')}
                >
                  All on
                </button>
                <button
                  type="button"
                  className="toggle toggle--small"
                  disabled={lightsBusy || !lightsReady}
                  onClick={() => void act(lightIds, 'turn_off')}
                >
                  All off
                </button>
              </div>
            </div>
            <div className="lamps__row">
              {lights.entities.map((ref) => {
                const entity = entities[ref.entity_id];
                const on = isOn(entity);
                const busy = pending[ref.entity_id] === true;
                return (
                  <button
                    key={ref.entity_id}
                    type="button"
                    role="switch"
                    className={on ? 'lamp lamp--on' : 'lamp'}
                    disabled={busy || entity?.missing !== false}
                    aria-checked={on}
                    aria-label={labelFor(ref, entity)}
                    onClick={() => void act([ref.entity_id], 'toggle')}
                  >
                    <LampGlyph on={on} />
                    <span className="lamp__name">{labelFor(ref, entity)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {sensors && sensors.length > 0 ? (
          // rows--stamped keeps the "changed …" stamp on phones - when a door
          // opened matters as much as that it is open.
          <ul className="rows rows--stamped">
            {sensors.map((ref) => {
              const entity = entities[ref.entity_id];
              const { text, tone } = senseReading(entity);
              return (
                <li key={ref.entity_id} className="row row--control">
                  <span className="row__label">{labelFor(ref, entity)}</span>
                  <span className="row__meta">{entity?.lastChanged ? formatRelative(entity.lastChanged) : ''}</span>
                  <span className={`sense sense--${tone}`}>
                    <span className="sense__dot" aria-hidden="true" />
                    {text}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}

        <ul className="rows">
          {refs.map((ref) => {
            const entity = entities[ref.entity_id];
            const on = isOn(entity);
            const busy = pending[ref.entity_id] === true;
            return (
              <li key={ref.entity_id} className="row row--control">
                <span className="row__label">{labelFor(ref, entity)}</span>
                <span className="row__meta">{busy ? 'switching…' : formatState(entity)}</span>
                {/* role="switch" rather than a pressed button: this reports a state
                    that stays changed, not a momentary press. */}
                <button
                  type="button"
                  role="switch"
                  className={on ? 'switch switch--on' : 'switch'}
                  disabled={busy || entity?.missing !== false}
                  aria-checked={on}
                  aria-label={labelFor(ref, entity)}
                  onClick={() => void act([ref.entity_id], 'toggle')}
                >
                  <span className="switch__track" aria-hidden="true">
                    <span className="switch__knob" />
                  </span>
                  <span className="switch__text">{on ? 'On' : 'Off'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}
