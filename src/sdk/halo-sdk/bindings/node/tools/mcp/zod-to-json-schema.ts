/**
 * @module tools/mcp/zod-to-json-schema
 *
 * Zod schema → JSON schema conversion using `@modelcontextprotocol/sdk`'s
 * internal conversion pipeline:
 *   normalizeObjectSchema(zodSchema)  → normalised Zod object
 *   toJsonSchemaCompat(normalised)    → JSON schema plain object
 *
 * Accepts:
 *   - Zod raw shape  `{ url: z.string() }` (used by sdk-server.ts tool())
 *   - Full Zod object schema              (used by bridge.ts external SDK path)
 *   - Already-converted JSON schema       (returned as-is)
 *
 * Falls back to `{ type: 'object', properties: {} }` if the MCP SDK
 * internals are not accessible (e.g. in a test environment without the dep).
 *
 * @license MIT
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getLogger } from '../../utils/logger.js';

const EMPTY_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

// Lazily loaded conversion functions from @modelcontextprotocol/sdk internals.
// Same functions used by the MCP SDK's tools/list handler.
let _normalizeObjectSchema: ((s: unknown) => unknown) | null = null;
let _toJsonSchemaCompat: ((s: unknown, opts: unknown) => Record<string, unknown>) | null = null;
let _loaded = false;
let _loadError: string | null = null;

function loadConverters(): boolean {
  if (_loaded) return _normalizeObjectSchema !== null;
  _loaded = true;

  // Try multiple require strategies for Electron/bundler compatibility
  const requireStrategies: Array<() => NodeRequire> = [
    // Strategy 1: createRequire from import.meta.url
    () => createRequire(import.meta.url),
    // Strategy 2: createRequire from process.cwd()
    () => createRequire(join(process.cwd(), 'package.json')),
    // Strategy 3: Use global require if available (CJS context)
    () => {
      if (typeof require !== 'undefined') return require as unknown as NodeRequire;
      throw new Error('No global require');
    },
  ];

  for (const getRequire of requireStrategies) {
    try {
      const req = getRequire();
      const zodCompat = req('@modelcontextprotocol/sdk/server/zod-compat.js') as {
        normalizeObjectSchema: (s: unknown) => unknown;
      };
      const zodJsonSchema = req('@modelcontextprotocol/sdk/server/zod-json-schema-compat.js') as {
        toJsonSchemaCompat: (s: unknown, opts: unknown) => Record<string, unknown>;
      };
      _normalizeObjectSchema = zodCompat.normalizeObjectSchema;
      _toJsonSchemaCompat = zodJsonSchema.toJsonSchemaCompat;
      return true;
    } catch (err) {
      // Continue to next strategy
      _loadError = err instanceof Error ? err.message : String(err);
    }
  }

  // All strategies failed
  getLogger('MCP:Schema').error('failed to load @modelcontextprotocol/sdk converters; schemas will be empty', { err: _loadError });
  return false;
}

/**
 * Convert a Zod schema (raw shape or object schema) to a JSON schema plain object.
 *
 * Uses the same conversion pipeline as the MCP SDK `tools/list` handler:
 *   `normalizeObjectSchema` + `toJsonSchemaCompat` with `{ strictUnions: true, pipeStrategy: 'input' }`.
 *
 * Anything that carries no Zod marker is assumed to be a JSON schema already and
 * is returned as-is.
 */
export function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return EMPTY_SCHEMA;
  }

  const s = schema as Record<string, unknown>;

  const isZod = ('_zod' in s) || ('_def' in s);
  // Raw shape: plain object where values are Zod schemas (have _def or _zod or .parse).
  const isRawShape = !isZod && Object.values(s).length > 0 &&
    Object.values(s).every((v) =>
      v !== null &&
      typeof v === 'object' &&
      ('_def' in (v as object) || '_zod' in (v as object) || typeof (v as Record<string, unknown>).parse === 'function'),
    );

  // Not Zod — already a JSON schema, or not ours to touch. Return as-is.
  //
  // This decision must come AFTER Zod detection. A raw shape may declare a
  // parameter literally named `type`, `properties` or `$schema`; reading that
  // name as a JSON-schema marker returns the shape unconverted, and the model
  // then receives a tool whose parameters are raw Zod internals with no
  // `properties` — so it calls the tool with `{}` on every attempt.
  if (!isZod && !isRawShape) {
    return s;
  }

  if (!loadConverters() || !_normalizeObjectSchema || !_toJsonSchemaCompat) {
    return EMPTY_SCHEMA;
  }

  try {
    const normalized = _normalizeObjectSchema(schema);
    if (normalized) {
      return _toJsonSchemaCompat(normalized, { strictUnions: true, pipeStrategy: 'input' });
    }
    getLogger('MCP:Schema').error('Zod schema normalized to nothing; tool will expose no parameters');
  } catch (err) {
    getLogger('MCP:Schema').error('Zod → JSON schema conversion failed; tool will expose no parameters', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return EMPTY_SCHEMA;
}
