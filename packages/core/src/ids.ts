/** Canonical identifiers: `provider:type:id`. Source IDs are stored unchanged after the namespace. */
export type EntityType = 'stop' | 'route' | 'trip' | 'vehicle' | 'alert';

export function makeId(provider: string, type: EntityType, id: string): string {
  return `${provider}:${type}:${id}`;
}

export interface ParsedId {
  provider: string;
  type: EntityType;
  id: string;
}

const TYPES = new Set<string>(['stop', 'route', 'trip', 'vehicle', 'alert']);

/** Returns null when the string is not a canonical id. The source id may itself contain ':'. */
export function parseId(canonical: string): ParsedId | null {
  const first = canonical.indexOf(':');
  if (first <= 0) return null;
  const second = canonical.indexOf(':', first + 1);
  if (second <= first + 1) return null;
  const provider = canonical.slice(0, first);
  const type = canonical.slice(first + 1, second);
  const id = canonical.slice(second + 1);
  if (!TYPES.has(type) || id.length === 0) return null;
  return { provider, type: type as EntityType, id };
}
