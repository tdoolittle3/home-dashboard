import type { EntityRef, EntitySnapshot } from './types';

const ON_STATES = new Set(['on', 'open', 'home', 'playing', 'active', 'detected']);
const PROBLEM_STATES = new Set(['unavailable', 'unknown', 'error']);

export function isOn(entity: EntitySnapshot | undefined): boolean {
  return entity ? ON_STATES.has(entity.state.toLowerCase()) : false;
}

export function isProblem(entity: EntitySnapshot | undefined): boolean {
  if (!entity) return true;
  if (PROBLEM_STATES.has(entity.state.toLowerCase())) return true;
  // A binary_sensor with device_class "problem" reports trouble as "on".
  return entity.deviceClass === 'problem' && isOn(entity);
}

export function labelFor(ref: EntityRef, entity: EntitySnapshot | undefined): string {
  return ref.name ?? entity?.friendlyName ?? ref.entity_id;
}

export function formatState(entity: EntitySnapshot | undefined): string {
  if (!entity) return 'unavailable';
  if (entity.missing) return 'not in HA';

  const numeric = Number(entity.state);
  const value = Number.isFinite(numeric) && entity.state.trim() !== '' ? formatNumber(numeric) : entity.state;
  return entity.unit ? `${value} ${entity.unit}` : value;
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function formatMb(megabytes: number | null): string {
  if (megabytes === null) return '-';
  if (megabytes >= 1024) return `${formatNumber(megabytes / 1024)} GB`;
  return `${formatNumber(megabytes)} MB`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return '-';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatRelative(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 5_400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function formatEpoch(seconds: number | null): string {
  if (seconds === null) return '';
  return formatRelative(new Date(seconds * 1000).toISOString());
}
