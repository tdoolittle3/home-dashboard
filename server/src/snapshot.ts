import type { AppConfig, DashboardConfig } from './config.js';
import type { HaClient, HaStatus, HassState } from './ha/client.js';
import { createFrigateSource, type FrigateSummary } from './sources/frigate.js';
import { cached, toResult, type SourceResult } from './sources/http.js';
import { createJellyfinSource, type JellyfinSummary } from './sources/jellyfin.js';
import { createUptimeKumaSource, type KumaSummary } from './sources/uptimeKuma.js';

export interface EntitySnapshot {
  entity_id: string;
  state: string;
  friendlyName: string | null;
  unit: string | null;
  deviceClass: string | null;
  icon: string | null;
  lastChanged: string | null;
  /** True when the entity is not in HA at all - usually a typo in dashboard.json. */
  missing: boolean;
}

export interface SourcesSnapshot {
  frigate: SourceResult<FrigateSummary> | null;
  jellyfin: SourceResult<JellyfinSummary> | null;
  uptimeKuma: SourceResult<KumaSummary> | null;
}

export interface Snapshot {
  generatedAt: string;
  dashboard: DashboardConfig;
  ha: HaStatus;
  entities: Record<string, EntitySnapshot>;
  sources: SourcesSnapshot;
}

function attr(state: HassState, key: string): string | null {
  const value = state.attributes[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function toEntitySnapshot(entityId: string, state: HassState | null): EntitySnapshot {
  if (!state) {
    return {
      entity_id: entityId,
      state: 'unavailable',
      friendlyName: null,
      unit: null,
      deviceClass: null,
      icon: null,
      lastChanged: null,
      missing: true,
    };
  }
  return {
    entity_id: entityId,
    state: state.state,
    friendlyName: attr(state, 'friendly_name'),
    unit: attr(state, 'unit_of_measurement'),
    deviceClass: attr(state, 'device_class'),
    icon: attr(state, 'icon'),
    lastChanged: state.last_changed ?? null,
    missing: false,
  };
}

/**
 * Assembles the payload the browser renders. Home Assistant data comes from the
 * live in-memory store (no request to HA), while the polled services sit behind
 * a short TTL cache so page refreshes do not hammer them.
 */
export class SnapshotBuilder {
  #config: AppConfig;
  #ha: HaClient;
  #frigate: (() => Promise<SourceResult<FrigateSummary>>) | null;
  #jellyfin: (() => Promise<SourceResult<JellyfinSummary>>) | null;
  #uptimeKuma: (() => Promise<SourceResult<KumaSummary>>) | null;

  constructor(config: AppConfig, ha: HaClient) {
    this.#config = config;
    this.#ha = ha;

    const ttl = config.sourceTtlMs;
    const { frigate, jellyfin, uptimeKuma } = config;

    const frigateSource = frigate ? createFrigateSource(frigate.baseUrl) : null;
    const jellyfinSource = jellyfin ? createJellyfinSource(jellyfin.baseUrl, jellyfin.apiKey) : null;
    const kumaSource = uptimeKuma ? createUptimeKumaSource(uptimeKuma.baseUrl, uptimeKuma.apiKey) : null;

    this.#frigate = frigateSource ? cached(ttl, () => toResult('frigate', frigateSource)) : null;
    this.#jellyfin = jellyfinSource ? cached(ttl, () => toResult('jellyfin', jellyfinSource)) : null;
    this.#uptimeKuma = kumaSource ? cached(ttl, () => toResult('uptime-kuma', kumaSource)) : null;
  }

  entities(): Record<string, EntitySnapshot> {
    const entities: Record<string, EntitySnapshot> = {};
    for (const entityId of this.#config.watchedEntities) {
      entities[entityId] = toEntitySnapshot(entityId, this.#ha.states.get(entityId) ?? null);
    }
    return entities;
  }

  async sources(): Promise<SourcesSnapshot> {
    const [frigate, jellyfin, uptimeKuma] = await Promise.all([
      this.#frigate ? this.#frigate() : Promise.resolve(null),
      this.#jellyfin ? this.#jellyfin() : Promise.resolve(null),
      this.#uptimeKuma ? this.#uptimeKuma() : Promise.resolve(null),
    ]);
    return { frigate, jellyfin, uptimeKuma };
  }

  async build(): Promise<Snapshot> {
    return {
      generatedAt: new Date().toISOString(),
      dashboard: this.#config.dashboard,
      ha: this.#ha.status,
      entities: this.entities(),
      sources: await this.sources(),
    };
  }
}
