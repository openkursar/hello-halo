/**
 * Unit tests for parseCatalogModelCapabilities — the provider-neutral
 * capability extractor shared by the main-process model fetch
 * (api-validator.service.ts) and the renderer preset-gateway hook
 * (usePresetModels.ts).
 *
 * Fixtures mirror real shapes rather than invented ones:
 *   - The OpenRouter fixture is the exact field set OpenRouter's
 *     `/api/v1/models` returned for `~z-ai/glm-flash-latest` at the time this
 *     was written (context_length: 1310720, top_provider.max_completion_tokens:
 *     131072, architecture.input_modalities: text/image/video) — the model at
 *     the center of the bug report this module fixes.
 *   - The "generic gateway" fixture covers the flatter `context_window` /
 *     `max_output_tokens` shape some non-OpenRouter gateways use.
 */

import { describe, it, expect } from 'vitest'
import {
  parseCatalogModelCapabilities,
  parseCatalogModelOption
} from '../../../src/shared/model-catalog'

describe('parseCatalogModelCapabilities', () => {
  it('extracts context/output/vision from an OpenRouter-shaped entry', () => {
    const raw = {
      id: '~z-ai/glm-flash-latest',
      name: 'Z.ai: GLM Flash Latest',
      canonical_slug: '~z-ai/glm-flash-latest',
      context_length: 1310720,
      architecture: {
        modality: 'text+image+video->text',
        input_modalities: ['text', 'image', 'video'],
        output_modalities: ['text']
      },
      top_provider: {
        context_length: 1310720,
        max_completion_tokens: 131072
      }
    }

    expect(parseCatalogModelCapabilities(raw)).toEqual({
      contextWindow: 1310720,
      maxOutputTokens: 131072
    })
  })

  it('extracts from a flat context_window / max_output_tokens shape', () => {
    const raw = {
      id: 'some-model',
      context_window: 200000,
      max_output_tokens: 64000,
      input_modalities: ['text']
    }

    expect(parseCatalogModelCapabilities(raw)).toEqual({
      contextWindow: 200000,
      maxOutputTokens: 64000
    })
  })

  it('extracts camelCase contextWindow / maxOutputTokens', () => {
    const raw = { id: 'x', contextWindow: 128000, maxOutputTokens: 8192 }
    expect(parseCatalogModelCapabilities(raw)).toEqual({
      contextWindow: 128000,
      maxOutputTokens: 8192
    })
  })

  it('prefers top_provider.max_completion_tokens over a top-level max_completion_tokens', () => {
    const raw = {
      id: 'x',
      max_completion_tokens: 4096,
      top_provider: { max_completion_tokens: 131072 }
    }
    expect(parseCatalogModelCapabilities(raw)?.maxOutputTokens).toBe(131072)
  })

  it('returns undefined for an entry with no recognizable capability field', () => {
    expect(parseCatalogModelCapabilities({ id: 'model-a' })).toBeUndefined()
  })

  it('returns undefined for non-object input', () => {
    expect(parseCatalogModelCapabilities(null)).toBeUndefined()
    expect(parseCatalogModelCapabilities(undefined)).toBeUndefined()
    expect(parseCatalogModelCapabilities('model-a')).toBeUndefined()
    expect(parseCatalogModelCapabilities(42)).toBeUndefined()
  })

  it('ignores non-positive or non-numeric context/output values', () => {
    const raw = { id: 'x', context_length: 0, max_completion_tokens: -1 }
    expect(parseCatalogModelCapabilities(raw)).toBeUndefined()
  })

  it('ignores non-numeric context/output values', () => {
    const raw = { id: 'x', context_length: '200000', max_completion_tokens: 'unlimited' }
    expect(parseCatalogModelCapabilities(raw)).toBeUndefined()
  })

  it('returns a partial object when only one field is present', () => {
    expect(parseCatalogModelCapabilities({ id: 'x', context_length: 200000 })).toEqual({
      contextWindow: 200000
    })
  })

  it('never carries vision — that field belongs to ModelOption.supportsVision', () => {
    const raw = { id: 'x', context_length: 128000, input_modalities: ['text', 'image'] }
    const result = parseCatalogModelCapabilities(raw)
    expect(result).toEqual({ contextWindow: 128000 })
    expect(result).not.toHaveProperty('vision')
  })
})

describe('parseCatalogModelOption', () => {
  it('reports supportsVision only when the catalog states image input', () => {
    expect(parseCatalogModelOption({ id: 'x', input_modalities: ['text', 'image'] }))
      .toEqual({ id: 'x', name: 'x', supportsVision: true })
  })

  it('matches the modality token case-insensitively', () => {
    expect(parseCatalogModelOption({ id: 'x', input_modalities: ['text', 'Image'] }))
      .toEqual({ id: 'x', name: 'x', supportsVision: true })
  })

  it('reads image input from the nested architecture shape', () => {
    expect(parseCatalogModelOption({
      id: 'x',
      architecture: { input_modalities: ['text', 'image'] }
    })).toEqual({ id: 'x', name: 'x', supportsVision: true })
  })

  // A gateway omitting "image" is not proof of absence — leaving the field out
  // keeps the id heuristic in charge instead of stripping a working model's
  // images. Asserting the absence of the key, not just a falsy value.
  it('omits supportsVision when the catalog lists no image modality', () => {
    const result = parseCatalogModelOption({ id: 'x', input_modalities: ['text'] })
    expect(result).toEqual({ id: 'x', name: 'x' })
    expect(result).not.toHaveProperty('supportsVision')
  })

  it('omits supportsVision when no modality field is present', () => {
    const result = parseCatalogModelOption({ id: 'x' })
    expect(result).not.toHaveProperty('supportsVision')
  })

  it('keeps the provider display name and falls back to the id', () => {
    expect(parseCatalogModelOption({ id: 'x', name: 'Fancy X' })?.name).toBe('Fancy X')
    expect(parseCatalogModelOption({ id: 'x', name: '   ' })?.name).toBe('x')
    expect(parseCatalogModelOption({ id: 'x', name: 42 })?.name).toBe('x')
  })

  it('trims the id and rejects entries without a usable one', () => {
    expect(parseCatalogModelOption({ id: '  x  ' })?.id).toBe('x')
    expect(parseCatalogModelOption({ id: '   ' })).toBeUndefined()
    expect(parseCatalogModelOption({ name: 'no id' })).toBeUndefined()
    expect(parseCatalogModelOption(null)).toBeUndefined()
    expect(parseCatalogModelOption([{ id: 'x' }])).toBeUndefined()
  })

  it('attaches catalog limits under capabilities', () => {
    expect(parseCatalogModelOption({ id: 'x', context_length: 128000 })).toEqual({
      id: 'x',
      name: 'x',
      capabilities: { contextWindow: 128000 }
    })
  })

  it('omits capabilities when the entry states no usable limit', () => {
    const result = parseCatalogModelOption({ id: 'x', context_length: 0 })
    expect(result).toEqual({ id: 'x', name: 'x' })
    expect(result).not.toHaveProperty('capabilities')
  })
})
