/**
 * Unit tests for resolveModelVision — the one answer the input hint, the
 * backend config and the image fallback all resolve through.
 *
 * The layering is what matters: a per-model override (user setting or a
 * capability the provider catalog declared) must beat the provider's static
 * flag, which must beat the id heuristic. A gateway alias like `public` is
 * unreadable by name, so without the override layer it defaults to
 * vision-capable and images reach a text-only upstream.
 */

import { describe, it, expect } from 'vitest'
import { resolveModelVision } from '../../../src/shared/constants/model-capabilities'

describe('resolveModelVision', () => {
  it('lets a per-model override win over the id heuristic', () => {
    // `public` is unknown to the heuristic, which defaults to vision-capable.
    const source = {
      modelOverrides: { public: { vision: false } },
      availableModels: [{ id: 'public', name: 'auto' }]
    }
    expect(resolveModelVision(source, 'public')).toBe(false)
  })

  it('lets a per-model override re-enable a blacklisted model id', () => {
    const source = {
      modelOverrides: { 'glm-5.2': { vision: true } },
      availableModels: [{ id: 'glm-5.2', name: 'GLM 5.2' }]
    }
    expect(resolveModelVision(source, 'glm-5.2')).toBe(true)
  })

  it('lets a per-model override win over the provider-declared flag', () => {
    const source = {
      modelOverrides: { 'model-x': { vision: true } },
      availableModels: [{ id: 'model-x', name: 'X', supportsVision: false }]
    }
    expect(resolveModelVision(source, 'model-x')).toBe(true)
  })

  it('falls back to the provider-declared flag when no override exists', () => {
    const source = {
      availableModels: [{ id: 'qwen3.6-35b-a3b', name: 'Qwen', supportsVision: true }]
    }
    expect(resolveModelVision(source, 'qwen3.6-35b-a3b')).toBe(true)
  })

  it('falls back to the id heuristic for a model missing from availableModels', () => {
    const source = { availableModels: [{ id: 'other', name: 'Other' }] }
    expect(resolveModelVision(source, 'deepseek-v4-flash')).toBe(false)
    expect(resolveModelVision(source, 'gpt-4o')).toBe(true)
  })

  it('ignores an override keyed to a different model', () => {
    const source = {
      modelOverrides: { 'glm-5.2': { vision: false } },
      availableModels: [{ id: 'gpt-4o', name: 'GPT-4o' }]
    }
    expect(resolveModelVision(source, 'gpt-4o')).toBe(true)
  })

  it('degrades to the id heuristic without a source', () => {
    expect(resolveModelVision(null, 'deepseek-chat')).toBe(false)
    expect(resolveModelVision(undefined, 'unknown-model')).toBe(true)
  })
})
