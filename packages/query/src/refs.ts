import { ToolError, parseId } from '@lkt/core';
import type { EntityType, ProviderConfig } from '@lkt/core';
import type { QueryContext } from './types.js';

function unknownProvider(ctx: QueryContext, id: string): ToolError {
  return new ToolError('unknown_provider', `Unknown provider '${id}'.`, {
    provider: id,
    available: Object.keys(ctx.providers),
  });
}

/**
 * Chooses the provider for a call: an explicit `provider` input wins; otherwise the namespace of the first canonical
 * id among `refs`; otherwise the default provider.
 */
export function pickProvider(ctx: QueryContext, explicit: string | undefined, refs: (string | undefined)[] = []): ProviderConfig {
  if (explicit !== undefined) {
    const cfg = ctx.providers[explicit];
    if (!cfg) throw unknownProvider(ctx, explicit);
    return cfg;
  }
  for (const ref of refs) {
    const parsed = ref === undefined ? null : parseId(ref);
    if (parsed) {
      const cfg = ctx.providers[parsed.provider];
      if (!cfg) throw unknownProvider(ctx, parsed.provider);
      return cfg;
    }
  }
  const cfg = ctx.providers[ctx.defaultProvider];
  if (!cfg) throw unknownProvider(ctx, ctx.defaultProvider);
  return cfg;
}

/** Strips the canonical prefix (`lmt:stop:22` -> `22`); bare source ids pass through. Wrong provider/type => invalid_argument. */
export function sourceId(cfg: ProviderConfig, raw: string, type: EntityType): string {
  const parsed = parseId(raw);
  if (!parsed) return raw.trim();
  if (parsed.provider !== cfg.id) {
    throw new ToolError('invalid_argument', `Id '${raw}' belongs to provider '${parsed.provider}', not '${cfg.id}'.`, {
      provider: cfg.id,
    });
  }
  if (parsed.type !== type) {
    throw new ToolError('invalid_argument', `Expected a ${type} id but got a ${parsed.type} id ('${raw}').`);
  }
  return parsed.id;
}
