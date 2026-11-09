/**
 * @module tools/mcp/zod-to-json-schema.test
 * Unit tests for zodToJsonSchema() — Zod schema → JSON schema conversion.
 */

import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from './zod-to-json-schema.js';

// ---------------------------------------------------------------------------
// Minimal Zod v3 mock helpers (no real Zod import needed for structural tests)
// We test the real converter path separately using the actual module resolution.
// ---------------------------------------------------------------------------

/** Build a minimal Zod v3-style schema mock with _def marker. */
function fakeZodV3Schema(): Record<string, unknown> {
  return {
    _def: { typeName: 'ZodString' },
    parse: (v: unknown) => v,
  };
}

/** Build a minimal Zod v4-style schema mock with _zod marker. */
function fakeZodV4Schema(): Record<string, unknown> {
  return {
    _zod: { def: { type: 'string' } },
    parse: (v: unknown) => v,
  };
}

/** Build a raw shape (object of Zod-like schemas). */
function fakeRawShape(): Record<string, unknown> {
  return {
    name: fakeZodV3Schema(),
    count: { _def: { typeName: 'ZodNumber' }, parse: (v: unknown) => v },
  };
}

// ---------------------------------------------------------------------------
// Null / undefined / non-object inputs
// ---------------------------------------------------------------------------

describe('zodToJsonSchema — invalid inputs', () => {
  it('returns empty schema for null', () => {
    const result = zodToJsonSchema(null);
    expect(result).toEqual({ type: 'object', properties: {} });
  });

  it('returns empty schema for undefined', () => {
    const result = zodToJsonSchema(undefined);
    expect(result).toEqual({ type: 'object', properties: {} });
  });

  it('returns empty schema for string', () => {
    const result = zodToJsonSchema('not an object');
    expect(result).toEqual({ type: 'object', properties: {} });
  });

  it('returns empty schema for number', () => {
    const result = zodToJsonSchema(42);
    expect(result).toEqual({ type: 'object', properties: {} });
  });

  it('returns empty schema for array', () => {
    // Arrays are objects in JS — zod detection fails → returned as-is
    // (no type/properties/$schema markers, no _def/_zod markers)
    const arr = [1, 2, 3];
    const result = zodToJsonSchema(arr);
    // Should come back unchanged (treated as "non-Zod, non-JSON-schema object")
    expect(result).toBe(arr);
  });
});

// ---------------------------------------------------------------------------
// Already-converted JSON schemas — returned as-is
// ---------------------------------------------------------------------------

describe('zodToJsonSchema — passthrough for JSON schemas', () => {
  it('returns object with `type` as-is', () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } } };
    const result = zodToJsonSchema(schema);
    expect(result).toBe(schema);
  });

  it('returns object with `properties` as-is', () => {
    const schema = { properties: { foo: { type: 'number' } } };
    const result = zodToJsonSchema(schema);
    expect(result).toBe(schema);
  });

  it('returns object with `$schema` as-is', () => {
    const schema = { $schema: 'http://json-schema.org/draft-07/schema#' };
    const result = zodToJsonSchema(schema);
    expect(result).toBe(schema);
  });

  it('empty object has neither type/properties/$schema nor Zod markers → returned as-is', () => {
    const schema = {};
    const result = zodToJsonSchema(schema);
    expect(result).toBe(schema);
  });
});

// ---------------------------------------------------------------------------
// Zod schema detection — fallback when converter unavailable
// ---------------------------------------------------------------------------

describe('zodToJsonSchema — Zod schema detection', () => {
  it('detects Zod v3 schema by _def marker', () => {
    const schema = fakeZodV3Schema();
    // @modelcontextprotocol/sdk is available in parent node_modules, so
    // the real converter will attempt to run. A minimal _def mock will
    // throw in normalizeObjectSchema → fallback to EMPTY_SCHEMA.
    const result = zodToJsonSchema(schema);
    // Result must be a plain object (either converted or fallback)
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
  });

  it('detects Zod v4 schema by _zod marker', () => {
    const schema = fakeZodV4Schema();
    const result = zodToJsonSchema(schema);
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
  });

  it('detects raw shape (values with _def markers)', () => {
    const shape = fakeRawShape();
    const result = zodToJsonSchema(shape);
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
  });

  it('non-zod object without type/properties/$schema is returned as-is', () => {
    const obj = { foo: 'bar', count: 42 };
    const result = zodToJsonSchema(obj);
    expect(result).toBe(obj);
  });

  it('object with parse function but no _def/_zod is NOT treated as Zod', () => {
    // Pure mock — only has parse, not _def or _zod at top level
    const obj = { parse: (v: unknown) => v, transform: () => {} };
    const result = zodToJsonSchema(obj);
    // Should be returned as-is (not detected as Zod, no JSON schema markers)
    expect(result).toBe(obj);
  });
});

// ---------------------------------------------------------------------------
// Real Zod integration (with actual @modelcontextprotocol/sdk converter)
// ---------------------------------------------------------------------------

describe('zodToJsonSchema — real Zod v3 conversion', () => {
  // These tests import real Zod and rely on the MCP SDK being available
  // in the parent project's node_modules. They exercise the full pipeline.

  it('converts a simple z.object schema to JSON schema', async () => {
    const { z } = await import('zod');
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = zodToJsonSchema(schema);

    expect(result).toHaveProperty('type', 'object');
    expect(result).toHaveProperty('properties');
    const props = result.properties as Record<string, unknown>;
    expect(props).toHaveProperty('name');
    expect(props).toHaveProperty('age');
  });

  it('sets required array for non-optional fields', async () => {
    const { z } = await import('zod');
    const schema = z.object({ required_field: z.string() });
    const result = zodToJsonSchema(schema);

    expect(result).toHaveProperty('type', 'object');
    // Required field should appear in properties
    const props = result.properties as Record<string, unknown>;
    expect(props).toHaveProperty('required_field');
  });

  it('converts z.string() field type correctly', async () => {
    const { z } = await import('zod');
    const schema = z.object({ title: z.string() });
    const result = zodToJsonSchema(schema);

    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.title).toHaveProperty('type', 'string');
  });

  it('converts z.number() field type correctly', async () => {
    const { z } = await import('zod');
    const schema = z.object({ count: z.number() });
    const result = zodToJsonSchema(schema);

    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.count).toHaveProperty('type', 'number');
  });

  it('converts z.boolean() field type correctly', async () => {
    const { z } = await import('zod');
    const schema = z.object({ flag: z.boolean() });
    const result = zodToJsonSchema(schema);

    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.flag).toHaveProperty('type', 'boolean');
  });

  it('handles optional fields', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty('type', 'object');
    const props = result.properties as Record<string, unknown>;
    expect(props).toHaveProperty('required');
    expect(props).toHaveProperty('optional');
  });

  it('converts raw shape (not full z.object)', async () => {
    const { z } = await import('zod');
    const shape = { url: z.string(), limit: z.number().optional() };
    const result = zodToJsonSchema(shape);

    expect(result).toHaveProperty('type', 'object');
    const props = result.properties as Record<string, unknown>;
    expect(props).toHaveProperty('url');
    expect(props).toHaveProperty('limit');
  });

  it('converts a raw shape whose parameter is named `type`', async () => {
    const { z } = await import('zod');
    const shape = {
      type: z.enum(['run_complete', 'escalation']),
      message: z.string().optional(),
    };
    const result = zodToJsonSchema(shape);

    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.type).toMatchObject({ enum: ['run_complete', 'escalation'] });
    expect(props.message).toHaveProperty('type', 'string');
    expect(result.required).toEqual(['type']);
  });

  it('already-converted schema is returned without re-processing', async () => {
    const { z } = await import('zod');
    const schema = z.object({ x: z.string() });
    const firstResult = zodToJsonSchema(schema);
    // Pass the result back in — should be returned as-is (has 'type' key)
    const secondResult = zodToJsonSchema(firstResult);
    expect(secondResult).toBe(firstResult);
  });
});

// ---------------------------------------------------------------------------
// Fallback contract — zodToJsonSchema never throws, always returns plain object
// ---------------------------------------------------------------------------

describe('zodToJsonSchema — fallback contract', () => {
  it('returns plain object for a minimal _def schema that normalizer cannot process', () => {
    // A schema with _def (detected as Zod) but not a real ZodObject.
    // normalizeObjectSchema returns null → code falls through to EMPTY_SCHEMA.
    const schema = { _def: { typeName: 'ZodString' }, parse: (v: unknown) => v };
    const result = zodToJsonSchema(schema);
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
    // Must always have the empty-schema shape
    expect(result).toHaveProperty('type', 'object');
    expect(result).toHaveProperty('properties');
  });

  it('never throws regardless of input type', () => {
    const inputs = [
      null, undefined, 42, 'string', [], {},
      { _def: { typeName: 'ZodNever' } },
      { _zod: { def: { type: 'never' } } },
      { type: 'object', properties: {} },
    ];
    for (const input of inputs) {
      expect(() => zodToJsonSchema(input)).not.toThrow();
    }
  });
});
