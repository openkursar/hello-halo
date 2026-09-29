/**
 * Unit tests for the model price lookup that feeds the halo engine's
 * `modelPricing` option. The engine matches ids exactly and costs a miss at
 * zero, so these pin which wire spellings resolve and which must not.
 */

import { describe, it, expect } from 'vitest'
import type { ModelPricingTable } from '@hello-halo/agent-sdk'
import pricingData from '../../../src/shared/data/model-pricing.json'
import {
  findModelPrice,
  buildModelPricingTable
} from '../../../src/shared/constants/model-pricing'

describe('findModelPrice', () => {
  it('resolves a canonical id', () => {
    expect(findModelPrice('claude-opus-4-6')).toEqual({
      inputPerMtk: 5,
      outputPerMtk: 25,
      cacheCreationPerMtk: 6.25,
      cacheReadPerMtk: 0.5
    })
  })

  it('ignores the [1m] marker', () => {
    expect(findModelPrice('claude-opus-4-6[1m]')).toEqual(findModelPrice('claude-opus-4-6'))
  })

  it('strips routing prefixes and case', () => {
    expect(findModelPrice('Pro/zai-org/GLM-4.7')).toEqual(findModelPrice('glm-4.7'))
    expect(findModelPrice('minimax/minimax-m2.7')).toEqual(findModelPrice('MiniMax-M2.7'))
    expect(findModelPrice('openai/gpt-5.5')?.inputPerMtk).toBe(5)
  })

  it('falls back from a dated snapshot to its alias', () => {
    expect(findModelPrice('claude-haiku-4-5-20251001')?.inputPerMtk).toBe(1)
    expect(findModelPrice('gpt-4o-2024-08-06')?.inputPerMtk).toBe(2.5)
  })

  it('prefers a dated entry priced on its own', () => {
    expect(findModelPrice('gpt-4o-2024-05-13')?.inputPerMtk).toBe(5)
  })

  it('reads dots as dashes for gateway spellings', () => {
    expect(findModelPrice('anthropic/claude-opus-4.8')).toEqual(findModelPrice('claude-opus-4-8'))
    expect(findModelPrice('claude-sonnet-4.5')).toEqual(findModelPrice('claude-sonnet-4-5'))
  })

  it('does not guess a price from a model family', () => {
    expect(findModelPrice('deepseek-chat')).toBeNull()
    expect(findModelPrice('claude-opus-9')).toBeNull()
    expect(findModelPrice('gpt-5.5-mini')).toBeNull()
    expect(findModelPrice('')).toBeNull()
    expect(findModelPrice(undefined)).toBeNull()
  })
})

describe('buildModelPricingTable', () => {
  it('keys the session model under its exact spelling', () => {
    const table: ModelPricingTable = buildModelPricingTable(['claude-opus-4-6[1m]'])
    expect(table['claude-opus-4-6[1m]']).toEqual(findModelPrice('claude-opus-4-6'))
  })

  it('carries every canonical id for models named by sub-agents', () => {
    const table = buildModelPricingTable([])
    expect(table['claude-haiku-4-5']).toBeDefined()
    expect(table['minimax-m2.7']).toBeDefined()
  })

  it('carries the vendor spelling too, for a sub-agent that names a model that way', () => {
    const table = buildModelPricingTable([])
    expect(table['MiniMax-M2.7']).toEqual(findModelPrice('minimax-m2.7'))
  })

  it('omits an unknown session model', () => {
    const table = buildModelPricingTable(['my-gateway-alias'])
    expect(table['my-gateway-alias']).toBeUndefined()
  })
})

describe('model-pricing.json', () => {
  const { _meta, models } = pricingData as {
    _meta: { sources: Record<string, { url: string; retrievedAt: string }> }
    models: Record<string, Record<string, unknown>>
  }

  it('gives every entry a declared source and non-negative prices', () => {
    for (const [id, entry] of Object.entries(models)) {
      expect(_meta.sources[entry.source as string], id).toBeDefined()
      for (const field of ['inputPerMtk', 'outputPerMtk', 'cacheCreationPerMtk', 'cacheReadPerMtk']) {
        const value = entry[field]
        expect(typeof value === 'number' && value >= 0, `${id}.${field}`).toBe(true)
      }
    }
  })

  it('has no two ids that collide under normalisation', () => {
    const seen = new Map<string, string>()
    for (const id of Object.keys(models)) {
      const key = id.toLowerCase().replace(/\./g, '-')
      expect(seen.get(key), `${id} collides with ${seen.get(key)}`).toBeUndefined()
      seen.set(key, id)
    }
  })
})
