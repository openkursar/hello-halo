/**
 * Unit Tests for tool schema $ref/$defs dereferencing.
 *
 * Background: some MCP servers return tool inputSchemas that use JSON Schema
 * $ref/$defs (or legacy `definitions`). Strict OpenAI-compatible endpoints
 * (e.g. Kimi / Moonshot) reject schemas containing $ref. The converter must
 * inline these references before forwarding the request.
 *
 * See issue #97.
 */

import { describe, it, expect } from 'vitest'
import {
  toOpenAIParameters,
  anthropicToolToOpenAIChatTool,
  anthropicToolToResponsesTool,
} from '../../../src/main/openai-compat-router/converters/tools'
import type { AnthropicTool } from '../../../src/main/openai-compat-router/types'

// Helper — cast a plain object as AnthropicTool['input_schema'] for tests.
// Schemas in production come from external MCP servers, so they often have
// shapes that exceed the static type's narrow surface (e.g. $defs at root).
const schema = (s: Record<string, unknown>) => s as unknown as AnthropicTool['input_schema']

describe('toOpenAIParameters — fast-path (no $defs)', () => {
  it('preserves type/properties/required for a plain schema', () => {
    const result = toOpenAIParameters(schema({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    }))
    expect(result).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })
  })

  it('omits `required` when the input has none', () => {
    const result = toOpenAIParameters(schema({
      type: 'object',
      properties: { name: { type: 'string' } },
    }))
    expect(result).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
    })
    expect(result).not.toHaveProperty('required')
  })

  it('returns an empty object schema for null/undefined input', () => {
    expect(toOpenAIParameters(undefined as unknown as AnthropicTool['input_schema']))
      .toEqual({ type: 'object', properties: {} })
  })
})

describe('toOpenAIParameters — $defs dereferencing', () => {
  it('inlines a single $ref and strips $defs from the output', () => {
    const result = toOpenAIParameters(schema({
      type: 'object',
      properties: {
        record: { $ref: '#/$defs/Record' },
      },
      required: ['record'],
      $defs: {
        Record: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
      },
    }))

    expect(result).toEqual({
      type: 'object',
      properties: {
        record: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
      },
      required: ['record'],
    })
    expect(result).not.toHaveProperty('$defs')
    // Reproduces the exact pattern that broke Kimi: schema must be free of $ref
    expect(JSON.stringify(result)).not.toContain('$ref')
  })

  it('inlines $ref inside an array `items` schema', () => {
    const result = toOpenAIParameters(schema({
      type: 'object',
      properties: {
        records: {
          type: 'array',
          items: { $ref: '#/$defs/Row' },
        },
      },
      $defs: {
        Row: { type: 'object', properties: { v: { type: 'number' } } },
      },
    }))

    expect((result.properties as Record<string, unknown>).records).toEqual({
      type: 'array',
      items: { type: 'object', properties: { v: { type: 'number' } } },
    })
  })

  it('resolves nested $refs (def referencing another def)', () => {
    const result = toOpenAIParameters(schema({
      type: 'object',
      properties: {
        outer: { $ref: '#/$defs/Outer' },
      },
      $defs: {
        Outer: {
          type: 'object',
          properties: { inner: { $ref: '#/$defs/Inner' } },
        },
        Inner: { type: 'string' },
      },
    }))

    expect(result.properties).toEqual({
      outer: {
        type: 'object',
        properties: { inner: { type: 'string' } },
      },
    })
  })

  it('resolves the same $ref reused at multiple sites', () => {
    const result = toOpenAIParameters(schema({
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/Item' },
        b: { $ref: '#/$defs/Item' },
      },
      $defs: {
        Item: { type: 'string', description: 'shared' },
      },
    }))

    expect(result.properties).toEqual({
      a: { type: 'string', description: 'shared' },
      b: { type: 'string', description: 'shared' },
    })
  })
})

describe('toOpenAIParameters — legacy `definitions` keyword', () => {
  it('inlines #/definitions/<Name> refs (Draft 4-7 style)', () => {
    const result = toOpenAIParameters(schema({
      type: 'object',
      properties: {
        item: { $ref: '#/definitions/Item' },
      },
      definitions: {
        Item: { type: 'string' },
      },
    }))

    expect(result).toEqual({
      type: 'object',
      properties: { item: { type: 'string' } },
    })
    expect(result).not.toHaveProperty('definitions')
  })
})

describe('toOpenAIParameters — cycle protection', () => {
  it('does not infinite-loop on a self-referencing schema', () => {
    // Tree node: { value, children: TreeNode[] } — a real-world cycle.
    const result = toOpenAIParameters(schema({
      type: 'object',
      properties: {
        root: { $ref: '#/$defs/Node' },
      },
      $defs: {
        Node: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            children: {
              type: 'array',
              items: { $ref: '#/$defs/Node' },  // ← cycle
            },
          },
        },
      },
    }))

    // The first level expands; the cycle resolves to an unconstrained
    // schema ({}) which strict endpoints accept.
    expect(result.properties).toBeDefined()
    const root = (result.properties as Record<string, unknown>).root as Record<string, unknown>
    expect(root.type).toBe('object')
    const props = root.properties as Record<string, unknown>
    expect(props.value).toEqual({ type: 'string' })
    const children = props.children as Record<string, unknown>
    expect(children.type).toBe('array')
    // The recursive position is broken — items resolves to {} not another $ref
    expect(children.items).toEqual({})
    expect(JSON.stringify(result)).not.toContain('$ref')
  })

  it('does not infinite-loop on a mutual A→B→A cycle', () => {
    const result = toOpenAIParameters(schema({
      type: 'object',
      properties: { a: { $ref: '#/$defs/A' } },
      $defs: {
        A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
      },
    }))

    expect(JSON.stringify(result)).not.toContain('$ref')
  })
})

describe('toOpenAIParameters — unresolvable refs', () => {
  it('leaves external refs intact (URL ref, no $defs to resolve)', () => {
    const result = toOpenAIParameters(schema({
      type: 'object',
      properties: {
        ext: { $ref: 'https://example.com/schema.json' },
      },
      $defs: {
        Other: { type: 'string' },
      },
    }))

    // External refs cannot be inlined; preserved as-is so the upstream
    // endpoint can decide how to handle them.
    expect((result.properties as Record<string, unknown>).ext)
      .toEqual({ $ref: 'https://example.com/schema.json' })
  })

  it('leaves a ref intact when the target name is missing from $defs', () => {
    const result = toOpenAIParameters(schema({
      type: 'object',
      properties: {
        x: { $ref: '#/$defs/Missing' },
      },
      $defs: {
        Other: { type: 'string' },
      },
    }))

    expect((result.properties as Record<string, unknown>).x)
      .toEqual({ $ref: '#/$defs/Missing' })
  })
})

describe('anthropicToolToOpenAIChatTool / anthropicToolToResponsesTool integration', () => {
  it('produces a $ref-free Chat tool when input has $defs', () => {
    const tool: AnthropicTool = {
      name: 'smartsheet_add_records',
      description: 'Add records to a sheet',
      input_schema: schema({
        type: 'object',
        properties: { records: { $ref: '#/$defs/Row' } },
        required: ['records'],
        $defs: {
          Row: { type: 'object', properties: { id: { type: 'string' } } },
        },
      }) as AnthropicTool['input_schema'],
    }

    const chatTool = anthropicToolToOpenAIChatTool(tool)
    expect(chatTool.type).toBe('function')
    expect(chatTool.function.name).toBe('smartsheet_add_records')
    expect(JSON.stringify(chatTool.function.parameters)).not.toContain('$ref')
    expect(JSON.stringify(chatTool.function.parameters)).not.toContain('$defs')

    const responsesTool = anthropicToolToResponsesTool(tool)
    expect(responsesTool.type).toBe('function')
    expect(responsesTool.name).toBe('smartsheet_add_records')
    expect(JSON.stringify(responsesTool.parameters)).not.toContain('$ref')
    expect(JSON.stringify(responsesTool.parameters)).not.toContain('$defs')
  })

  it('keeps the existing fast-path shape for tools without $defs', () => {
    const tool: AnthropicTool = {
      name: 'simple_tool',
      description: 'Plain tool',
      input_schema: {
        type: 'object',
        properties: { msg: { type: 'string' } },
        required: ['msg'],
      },
    }

    const chatTool = anthropicToolToOpenAIChatTool(tool)
    expect(chatTool.function.parameters).toEqual({
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
    })
  })
})
