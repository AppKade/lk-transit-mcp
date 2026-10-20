import * as bindings from 'gtfs-realtime-bindings';
import type { transit_realtime } from 'gtfs-realtime-bindings';

// The package is CommonJS (`module.exports = $root`), so depending on the loader the namespace lives on the module
// itself (bundlers) or on `.default` (native Node ESM). The generated code is static protobufjs/minimal: no eval.
const mod = bindings as unknown as {
  transit_realtime?: typeof transit_realtime;
  default?: { transit_realtime?: typeof transit_realtime };
};
const resolved = mod.transit_realtime ?? mod.default?.transit_realtime;
if (!resolved) throw new Error('gtfs-realtime-bindings did not expose transit_realtime');

export const pb: typeof transit_realtime = resolved;
export type { transit_realtime };
