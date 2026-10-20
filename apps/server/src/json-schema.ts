import { TOOL_INPUTS, type ToolName } from '@lkt/core';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

type Json = Record<string, unknown>;

function resolvePointer(root: Json, ref: string): unknown {
  let cur: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cur = (cur as Record<string, unknown> | undefined)?.[key];
  }
  return cur;
}

/** Inlines `#/...` refs and rewrites draft-07 tuple `items` to 2020-12 `prefixItems`. */
function normalize(node: unknown, root: Json, depth = 0): unknown {
  if (depth > 12 || node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => normalize(n, root, depth + 1));
  const obj = node as Json;
  if (typeof obj.$ref === 'string' && obj.$ref.startsWith('#/')) {
    return normalize(resolvePointer(root, obj.$ref), root, depth + 1);
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'items' && Array.isArray(v)) {
      out.prefixItems = normalize(v, root, depth + 1);
      out.items = false;
    } else if (k === 'additionalItems') {
      continue;
    } else {
      out[k] = normalize(v, root, depth + 1);
    }
  }
  return out;
}

const cache = new Map<ToolName, Json>();

/** JSON Schema 2020-12 (`additionalProperties: false`) for a tool's input, generated from the shared zod schema. */
export function inputJsonSchema(name: ToolName): Json {
  const hit = cache.get(name);
  if (hit) return hit;
  const raw = toJsonSchemaCompat(TOOL_INPUTS[name] as never) as Json;
  const schema = normalize(raw, raw) as Json;
  delete schema.$schema;
  const out: Json = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema };
  if (name === 'plan_trip') {
    // The zod refinement (stop_id, or both coordinates) cannot be expressed by the converter; restate it.
    const props = out.properties as Record<string, Json>;
    for (const k of ['origin', 'destination']) {
      const p = props[k];
      if (p) p.anyOf = [{ required: ['stop_id'] }, { required: ['latitude', 'longitude'] }];
    }
  }
  cache.set(name, out);
  return out;
}

const freshnessSchema = {
  type: 'object',
  properties: {
    status: { enum: ['fresh', 'stale', 'unavailable'] },
    age_seconds: { type: ['number', 'null'] },
    threshold_seconds: { type: 'number' },
  },
  required: ['status', 'age_seconds', 'threshold_seconds'],
};

/**
 * Output schema shared by all tools. Success results are the standard envelope; error results (`isError: true`) carry
 * `{ error: { code, message } }` in `structuredContent`, so the schema accepts exactly one of the two shapes.
 */
export function outputJsonSchema(dataType: 'array' | 'object'): Json {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      provider: { type: 'string' },
      as_of: { type: 'string', description: 'Server time of the answer (ISO 8601, +05:30).' },
      freshness: freshnessSchema,
      source: {
        type: 'object',
        properties: {
          type: { enum: ['gtfs_static', 'gtfs_realtime', 'derived', 'mixed'] },
          url_ref: { type: 'array', items: { type: 'string' } },
          feed_version: { type: ['string', 'null'] },
          license: { type: 'string' },
          license_status: { type: 'string' },
          provider_authority: { type: 'string' },
          attribution: { type: 'string' },
        },
        required: ['type', 'url_ref', 'license', 'attribution'],
      },
      data: { type: dataType },
      error: {
        type: 'object',
        properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
        required: ['code', 'message'],
      },
    },
    oneOf: [{ required: ['provider', 'as_of', 'freshness', 'source', 'data'] }, { required: ['error'] }],
  };
}
