/**
 * Unit tests for the shared capability clamp every engine resolves through.
 *
 * The rule it encodes is asymmetric on purpose: `maxOutputTokens` is only
 * sanity-bounded because the user is allowed to go low, while `contextWindow`
 * keeps a hard floor because a window below it makes compaction fire every
 * turn. Engines add their own naming and warnings on top; none of them may
 * re-decide these numbers.
 */

import { describe, expect, it } from 'vitest'
import { clampModelRuntimeLimits } from '../../../src/shared/constants/model-runtime-limits'

describe('clampModelRuntimeLimits', () => {
  it('says nothing when the caller resolved no capabilities', () => {
    // An empty result means "leave the runtime's own default alone", which is
    // the only honest answer when Halo knows nothing about the model.
    expect(clampModelRuntimeLimits(undefined)).toEqual({})
  })

  it('passes values inside the safe range through untouched', () => {
    expect(clampModelRuntimeLimits({ maxOutputTokens: 64_000, contextWindow: 200_000 })).toEqual({
      maxOutputTokens: 64_000,
      contextWindow: 200_000,
    })
  })

  it('keeps a low output cap the user chose', () => {
    expect(
      clampModelRuntimeLimits({ maxOutputTokens: 8_192, contextWindow: 200_000 })
    ).toMatchObject({ maxOutputTokens: 8_192 })
  })

  it('lifts a context window that would compact on every turn', () => {
    expect(
      clampModelRuntimeLimits({ maxOutputTokens: 64_000, contextWindow: 32_768 })
    ).toMatchObject({ contextWindow: 40_000 })
  })

  it('caps both fields at their sanity ceilings', () => {
    expect(
      clampModelRuntimeLimits({ maxOutputTokens: 5_000_000, contextWindow: 10_000_000 })
    ).toEqual({ maxOutputTokens: 1_000_000, contextWindow: 2_000_000 })
  })

  it('rounds fractional inputs to integers', () => {
    expect(
      clampModelRuntimeLimits({ maxOutputTokens: 64_000.7, contextWindow: 200_000.3 })
    ).toEqual({ maxOutputTokens: 64_001, contextWindow: 200_000 })
  })

  it('omits a field the input could not describe rather than substituting a floor', () => {
    expect(clampModelRuntimeLimits({ maxOutputTokens: 0, contextWindow: 200_000 })).toEqual({
      contextWindow: 200_000,
    })
    expect(
      clampModelRuntimeLimits({ maxOutputTokens: 64_000, contextWindow: Number.NaN })
    ).toEqual({ maxOutputTokens: 64_000 })
  })

  it('bounds a GLM route to what the vendor accepts', () => {
    // The regression this function exists for: dsh used to send its SDK's
    // DeepSeek default (256K) to every provider, and a 131K-capped vendor
    // answered HTTP 400 on the parameter instead of running the turn.
    expect(
      clampModelRuntimeLimits({ maxOutputTokens: 131_072, contextWindow: 200_000 })
    ).toMatchObject({ maxOutputTokens: 131_072 })
  })
})
