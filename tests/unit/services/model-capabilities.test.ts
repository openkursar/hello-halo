/**
 * Unit tests for ModelCapabilitiesService.resolve().
 *
 * Invariants under test:
 *   - A `[1m]` model-id suffix (the user's explicit 1M context opt-in) raises
 *     the resolved contextWindow to 1M over preset/pattern/default values.
 *     Without this, the default 128K window is injected as
 *     CLAUDE_CODE_AUTO_COMPACT_WINDOW and Math.min-clamps the 1M intrinsic —
 *     the "UI shows 1M but compaction fires at ~99K" bug.
 *   - An explicit per-model contextWindow override still beats the suffix.
 *   - The generic `claude-` pattern covers new model families (fable, mythos)
 *     while `claude-haiku-` keeps its longer-prefix specialization.
 *   - `catalogCapability` (provider-declared, e.g. from a live /models fetch)
 *     ranks above built-in presets/defaults but below the user override and
 *     the `[1m]` suffix rule.
 */

import { describe, expect, it } from 'vitest'
import { modelCapabilitiesService } from '../../../src/main/services/model-capabilities.service'
import {
  resolveModelVision,
  supportsVisionById
} from '../../../src/shared/constants/model-capabilities'

describe('explicit [1m] suffix opt-in', () => {
  it('raises an unknown model from built-in default to 1M', () => {
    const cap = modelCapabilitiesService.resolve('totally-unknown-model[1m]')
    expect(cap.contextWindow).toBe(1_000_000)
  })

  it('raises a pattern-matched model above its 200K preset', () => {
    const cap = modelCapabilitiesService.resolve('claude-sonnet-4-6[1m]')
    expect(cap.contextWindow).toBe(1_000_000)
  })

  it('is case-insensitive ([1M])', () => {
    const cap = modelCapabilitiesService.resolve('claude-opus-4-8[1M]')
    expect(cap.contextWindow).toBe(1_000_000)
  })

  it('does not lower an exact preset that already exceeds 1M semantics', () => {
    const cap = modelCapabilitiesService.resolve('claude-fable-5[1m]')
    expect(cap.contextWindow).toBe(1_000_000)
  })

  it('keeps non-[1m] models on their resolved window', () => {
    expect(modelCapabilitiesService.resolve('deepseek-chat').contextWindow).toBe(128_000)
    expect(modelCapabilitiesService.resolve('totally-unknown-model').contextWindow).toBe(200_000)
  })

  it('an explicit per-model contextWindow override beats the suffix', () => {
    const cap = modelCapabilitiesService.resolve('claude-sonnet-4-6[1m]', {
      'claude-sonnet-4-6[1m]': { contextWindow: 500_000 }
    })
    expect(cap.contextWindow).toBe(500_000)
  })

  it('an override of unrelated fields does not block the raise', () => {
    const cap = modelCapabilitiesService.resolve('claude-sonnet-4-6[1m]', {
      'claude-sonnet-4-6[1m]': { maxOutputTokens: 32_000 }
    })
    expect(cap.contextWindow).toBe(1_000_000)
    expect(cap.maxOutputTokens).toBe(32_000)
  })
})

describe('claude- generic pattern', () => {
  it('covers new model families without dedicated entries', () => {
    const cap = modelCapabilitiesService.resolve('claude-mythos-preview')
    expect(cap.contextWindow).toBe(200_000)
    expect(cap.provider).toBe('anthropic')
    expect(cap.thinking).toBe(true)
  })

  it('claude-haiku- keeps its longer-prefix specialization (thinking: false)', () => {
    const cap = modelCapabilitiesService.resolve('claude-haiku-9-9')
    expect(cap.contextWindow).toBe(200_000)
    expect(cap.thinking).toBe(false)
  })
})

describe('built-in defaults', () => {
  it('falls back to 200K context / 64K output for a fully unknown model', () => {
    const cap = modelCapabilitiesService.resolve('totally-unknown-model')
    expect(cap.contextWindow).toBe(200_000)
    expect(cap.maxOutputTokens).toBe(64_000)
  })
})

describe('catalogCapability (provider-declared, live /models data)', () => {
  it('overrides the built-in default for a model with no preset', () => {
    // The reported bug: a custom OpenRouter model id with no bundled preset
    // (e.g. "~z-ai/glm-flash-latest") must use what the provider's own
    // catalog declared, not Halo's conservative fallback.
    const cap = modelCapabilitiesService.resolve(
      '~z-ai/glm-flash-latest',
      undefined,
      { contextWindow: 1_310_720, maxOutputTokens: 131_072 }
    )
    expect(cap.contextWindow).toBe(1_310_720)
    expect(cap.maxOutputTokens).toBe(131_072)
  })

  // Codex slugs have no entry of their own and land on the `gpt-5` / `gpt-6`
  // family patterns, whose 200K window is not theirs. The backend states the
  // real one; a family default must not outrank it, or every Codex model
  // compacts early. Regression: this is the bug the provider used to work
  // around by writing into modelOverrides.
  it('outranks a family pattern match', () => {
    for (const slug of ['gpt-5.5', 'gpt-5.6-sol', 'gpt-6-astra']) {
      expect(modelCapabilitiesService.getPreset(slug)).not.toBeNull()
      const cap = modelCapabilitiesService.resolve(slug, undefined, { contextWindow: 272_000 })
      expect(cap.contextWindow).toBe(272_000)
      // A field the catalog stayed silent on still comes from the pattern.
      expect(cap.maxOutputTokens).toBe(128_000)
    }
  })

  // Catalog data fills what nothing else knows; it does not restate curated
  // ones. Many OpenAI-compatible proxies report one blanket limit for every
  // model they front, so letting that outrank a deliberate per-model entry
  // would silently downgrade a known model to the proxy's house number.
  it('loses to a built-in exact preset', () => {
    const cap = modelCapabilitiesService.resolve(
      'deepseek-chat',
      undefined,
      { contextWindow: 999_000, maxOutputTokens: 4096 }
    )
    expect(cap.contextWindow).toBe(modelCapabilitiesService.getPreset('deepseek-chat')!.contextWindow)
    expect(cap.maxOutputTokens).toBe(8192)
  })

  it('loses to an explicit user override for the same field', () => {
    const cap = modelCapabilitiesService.resolve(
      '~z-ai/glm-flash-latest',
      { '~z-ai/glm-flash-latest': { contextWindow: 50_000 } },
      { contextWindow: 1_310_720, maxOutputTokens: 131_072 }
    )
    expect(cap.contextWindow).toBe(50_000)
    // Untouched field still comes from the catalog data.
    expect(cap.maxOutputTokens).toBe(131_072)
  })

  it('a partial catalog capability only overrides the fields it states', () => {
    const cap = modelCapabilitiesService.resolve(
      'totally-unknown-model',
      undefined,
      { contextWindow: 300_000 }
    )
    expect(cap.contextWindow).toBe(300_000)
    // maxOutputTokens still falls through to the built-in default.
    expect(cap.maxOutputTokens).toBe(64_000)
  })

  it('does not affect vision, which is resolved by the shared id heuristic', () => {
    // catalogCapability never carries `vision` in practice (the parser keeps
    // it out — see shared/model-catalog.ts), but even if a caller passed one
    // it must not leak through: vision resolution stays a single answer.
    const cap = modelCapabilitiesService.resolve(
      'totally-unknown-model',
      undefined,
      { contextWindow: 300_000, vision: false } as any
    )
    expect(cap.vision).toBe(true)
  })
})

describe('resolve() result isolation and vision ownership', () => {
  // resolve() is fed to the panel and the SDK credential; handing back the
  // shared preset table entry would let one caller's edit corrupt the table
  // for the whole process.
  it('never hands back the shared preset object', () => {
    const preset = modelCapabilitiesService.getPreset('deepseek-chat')!
    const cap = modelCapabilitiesService.resolve('deepseek-chat')
    expect(cap).not.toBe(preset)
    cap.contextWindow = 1
    expect(modelCapabilitiesService.getPreset('deepseek-chat')!.contextWindow).not.toBe(1)
  })

  // The id chain reads allow/blocklist substring signals the preset blob
  // cannot express. The router and the renderer input gate answer through
  // that chain, so resolve() has to agree with it even when a preset matched
  // — otherwise the panel shows Vision on for a model whose images get
  // stripped on the wire.
  it('answers vision through the id chain even when a preset matched', () => {
    const rewritten = 'deepseek-proxy/gpt-4o'
    expect(modelCapabilitiesService.getPreset(rewritten)).not.toBeNull()
    expect(modelCapabilitiesService.resolve(rewritten).vision)
      .toBe(supportsVisionById(rewritten))
  })

  it('agrees with the id chain across every bundled preset id', () => {
    const divergent = Object.keys(modelCapabilitiesService.getAllPresets()).filter(
      id => modelCapabilitiesService.resolve(id).vision !== supportsVisionById(id)
    )
    expect(divergent).toEqual([])
  })

  // resolveModelVision is the single answer the router and the chat input gate
  // both gave before ModelOption.supportsVision had any producer. Now that it
  // has one, resolve() has to reach the same conclusion or the Vision checkbox
  // reads the opposite of what the wire does.
  it('matches resolveModelVision once the source states supportsVision', () => {
    const modelId = 'blind-model'
    for (const stated of [true, false]) {
      const source = {
        availableModels: [{ id: modelId, name: modelId, supportsVision: stated }],
        modelOverrides: {}
      }
      expect(modelCapabilitiesService.resolve(modelId, undefined, undefined, stated).vision)
        .toBe(resolveModelVision(source, modelId))
    }
  })

  it('still lets a user override beat what the source states', () => {
    const modelId = 'blind-model'
    const overrides = { [modelId]: { vision: true } }
    const source = { availableModels: [{ id: modelId, name: modelId, supportsVision: false }], overrides }
    expect(modelCapabilitiesService.resolve(modelId, overrides, undefined, false).vision).toBe(true)
    expect(resolveModelVision({ ...source, modelOverrides: overrides }, modelId)).toBe(true)
  })
})

describe('legacy claude-3 patterns', () => {
  // The generic `claude-` pattern advertises 64K output — far above what the
  // claude-3 generation accepts. Longer-prefix entries pin real limits so the
  // value injected as CLAUDE_CODE_MAX_OUTPUT_TOKENS is never rejected.
  it('claude-3 base generation caps output at 4096', () => {
    const cap = modelCapabilitiesService.resolve('claude-3-opus-20240229')
    expect(cap.maxOutputTokens).toBe(4096)
    expect(cap.contextWindow).toBe(200_000)
  })

  it('claude-3.5 caps output at 8192', () => {
    const cap = modelCapabilitiesService.resolve('claude-3-5-sonnet-20241022')
    expect(cap.maxOutputTokens).toBe(8192)
    expect(cap.vision).toBe(true)
  })

  it('claude-3.5 haiku resolves vision via the shared heuristic', () => {
    const cap = modelCapabilitiesService.resolve('claude-3-5-haiku-20241022')
    expect(cap.maxOutputTokens).toBe(8192)
    // Vision resolves through the shared id heuristic, not this pattern blob.
    expect(cap.vision).toBe(true)
  })

  it('claude-3.7 supports 64K output and thinking', () => {
    const cap = modelCapabilitiesService.resolve('claude-3-7-sonnet-20250219')
    expect(cap.maxOutputTokens).toBe(64_000)
    expect(cap.thinking).toBe(true)
  })
})
