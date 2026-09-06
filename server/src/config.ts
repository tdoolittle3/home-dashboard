import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';

export interface EntityRef {
  entity_id: string;
  name?: string;
}

export interface CameraRef {
  name: string;
  label?: string;
}

export type Panel =
  | {
      id: string;
      title: string;
      type: 'entities';
      entities: EntityRef[];
      /** Draw the largest filesystem Frigate reports above the rows. */
      chart?: 'disk';
    }
  | { id: string; title: string; type: 'controls'; entities: EntityRef[] }
  | { id: string; title: string; type: 'cameras'; cameras: CameraRef[]; refreshSeconds?: number };

export interface DashboardConfig {
  title: string;
  panels: Panel[];
  links: { label: string; url: string }[];
}

export interface AppConfig {
  port: number;
  host: string;
  ha: { baseUrl: string; token: string };
  frigate: { baseUrl: string } | null;
  jellyfin: { baseUrl: string; apiKey: string } | null;
  uptimeKuma: { baseUrl: string; apiKey: string } | null;
  sourceTtlMs: number;
  sourcePushMs: number;
  dashboard: DashboardConfig;
  /** Entity ids the dashboard is allowed to display. */
  watchedEntities: string[];
  /** Entity ids /api/action is allowed to write to. Derived from 'controls' panels. */
  controllableEntities: Set<string>;
  /** Frigate camera names /api/camera is allowed to proxy. Derived from 'cameras' panels. */
  proxyableCameras: Set<string>;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required - copy .env.example to .env and fill it in`);
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function loadDashboard(path: string): DashboardConfig {
  const raw = readFileSync(resolve(path), 'utf8');
  const parsed = JSON.parse(raw) as Partial<DashboardConfig>;
  if (!Array.isArray(parsed.panels)) throw new Error(`${path}: "panels" must be an array`);

  const seen = new Set<string>();
  for (const panel of parsed.panels) {
    if (!panel.id || !panel.title) throw new Error(`${path}: every panel needs an "id" and a "title"`);
    if (seen.has(panel.id)) throw new Error(`${path}: duplicate panel id "${panel.id}"`);
    seen.add(panel.id);

    if (panel.type === 'entities' || panel.type === 'controls') {
      if (!Array.isArray(panel.entities) || panel.entities.length === 0) {
        throw new Error(`${path}: panel "${panel.id}" needs a non-empty "entities" array`);
      }
      for (const entity of panel.entities) {
        if (!/^[a-z_]+\.[a-z0-9_]+$/.test(entity.entity_id ?? '')) {
          throw new Error(`${path}: panel "${panel.id}" has an invalid entity_id: ${entity.entity_id}`);
        }
      }
      if (panel.type === 'entities' && panel.chart !== undefined && panel.chart !== 'disk') {
        throw new Error(
          `${path}: panel "${panel.id}" has unknown chart "${panel.chart}" - the only chart is "disk"`,
        );
      }
    } else if (panel.type === 'cameras') {
      if (!Array.isArray(panel.cameras) || panel.cameras.length === 0) {
        throw new Error(`${path}: panel "${panel.id}" needs a non-empty "cameras" array`);
      }
      for (const camera of panel.cameras) {
        // Names land in a URL path we build against Frigate, so keep them boring.
        if (!/^[A-Za-z0-9_-]+$/.test(camera.name ?? '')) {
          throw new Error(`${path}: invalid camera name "${camera.name}" in panel "${panel.id}"`);
        }
      }
    } else {
      // `panel` has narrowed to never here, so read the raw JSON shape instead.
      const unknown = panel as unknown as { id: string; type: string };
      throw new Error(`${path}: panel "${unknown.id}" has unknown type "${unknown.type}"`);
    }
  }

  return {
    title: parsed.title ?? 'Home',
    panels: parsed.panels,
    links: Array.isArray(parsed.links) ? parsed.links : [],
  };
}

export function loadConfig(): AppConfig {
  const dashboard = loadDashboard(process.env['DASHBOARD_CONFIG']?.trim() || './config/dashboard.json');

  const watched = new Set<string>();
  const controllable = new Set<string>();
  const cameras = new Set<string>();

  for (const panel of dashboard.panels) {
    if (panel.type === 'entities' || panel.type === 'controls') {
      for (const entity of panel.entities) watched.add(entity.entity_id);
      if (panel.type === 'controls') {
        for (const entity of panel.entities) controllable.add(entity.entity_id);
      }
    } else {
      for (const camera of panel.cameras) cameras.add(camera.name);
    }
  }

  const jellyfinBase = optional('JELLYFIN_BASE_URL');
  const jellyfinKey = optional('JELLYFIN_API_KEY');
  const kumaBase = optional('UPTIME_KUMA_BASE_URL');
  const kumaKey = optional('UPTIME_KUMA_API_KEY');
  const frigateBase = optional('FRIGATE_BASE_URL');

  return {
    port: num('PORT', 8099),
    host: process.env['HOST']?.trim() || '0.0.0.0',
    ha: { baseUrl: stripTrailingSlash(required('HA_BASE_URL')), token: required('HA_TOKEN') },
    frigate: frigateBase ? { baseUrl: stripTrailingSlash(frigateBase) } : null,
    jellyfin: jellyfinBase && jellyfinKey ? { baseUrl: stripTrailingSlash(jellyfinBase), apiKey: jellyfinKey } : null,
    uptimeKuma: kumaBase && kumaKey ? { baseUrl: stripTrailingSlash(kumaBase), apiKey: kumaKey } : null,
    sourceTtlMs: num('SOURCE_TTL_SECONDS', 10) * 1000,
    sourcePushMs: num('SOURCE_PUSH_SECONDS', 15) * 1000,
    dashboard,
    watchedEntities: [...watched],
    controllableEntities: controllable,
    proxyableCameras: cameras,
  };
}
