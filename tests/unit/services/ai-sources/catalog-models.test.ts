import { describe, expect, it } from 'vitest'
import {
  catalogModel,
  presentationMap,
  recordCatalogChange,
  sanitizePresentation
} from '../../../../src/main/services/ai-sources/catalog-models'
import type { AISource, ModelOption } from '../../../../src/shared/types'

const AT = '2026-10-21T10:00:00.000Z'
const LATER = '2026-10-22T10:00:00.000Z'

function source(models: ModelOption[], over: Partial<AISource> = {}): AISource {
  return {
    id: 's', name: 'Account', provider: 'vendor-oauth', authType: 'oauth', apiUrl: '',
    model: models[0]?.id ?? '', availableModels: models, createdAt: AT, updatedAt: AT, ...over
  }
}

describe('model presentation from a provider', () => {
  it('keeps well-formed vendor fields', () => {
    expect(sanitizePresentation({
      group: 'enterprise',
      badge: { label: ' Night offer ', detail: 'Cheaper from 23:00 to 08:00' },
      costMultiplier: 0.5,
      regularCostMultiplier: 0.79
    })).toEqual({
      group: 'enterprise',
      badge: { label: 'Night offer', detail: 'Cheaper from 23:00 to 08:00' },
      costMultiplier: 0.5,
      regularCostMultiplier: 0.79
    })
  })

  it('drops whatever it cannot show safely', () => {
    expect(sanitizePresentation({
      group: 'partner',
      badge: { label: 'x'.repeat(40) },
      costMultiplier: -1,
      regularCostMultiplier: 2
    })).toEqual({})
    expect(sanitizePresentation({ badge: { label: 'Offer', detail: 7 }, costMultiplier: Number.NaN })).toEqual({ badge: { label: 'Offer' } })
    expect(sanitizePresentation({ costMultiplier: 1, regularCostMultiplier: 1 })).toEqual({ costMultiplier: 1 })
    expect(sanitizePresentation('enterprise')).toEqual({})
  })

  it('builds a stored entry from every per-model map and round-trips its presentation', () => {
    const model = catalogModel('m', {
      modelNames: { m: 'Model' },
      modelCapabilities: { m: { contextWindow: 300000 } },
      modelVision: { m: false },
      modelPresentation: { m: { group: 'enterprise', costMultiplier: 0.2, unknown: true } }
    })
    expect(model).toEqual({ id: 'm', name: 'Model', capabilities: { contextWindow: 300000 }, supportsVision: false, group: 'enterprise', costMultiplier: 0.2 })
    expect(presentationMap([model, { id: 'plain', name: 'Plain' }])).toEqual({ m: { group: 'enterprise', costMultiplier: 0.2 } })
    expect(catalogModel('bare', {})).toEqual({ id: 'bare', name: 'bare' })
  })
})

describe('what a fresh catalog changed', () => {
  it('remembers models the vendor stopped listing and forgets one that comes back', () => {
    const before = source([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
    const dropped = recordCatalogChange(before, source([{ id: 'a', name: 'A' }]), AT)
    expect(dropped.withdrawnModels).toEqual([{ id: 'b', name: 'B', at: AT }])

    const back = recordCatalogChange(dropped, source([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]), LATER)
    expect(back.withdrawnModels).toBeUndefined()
  })

  it('keeps the first time a model went missing, newest withdrawals first, and stays bounded', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, name: `M${i}` }))
    const first = recordCatalogChange(source([...many, { id: 'keep', name: 'Keep' }]), source([{ id: 'keep', name: 'Keep' }]), AT)
    expect(first.withdrawnModels).toHaveLength(50)
    const second = recordCatalogChange(
      source([{ id: 'keep', name: 'Keep' }, { id: 'late', name: 'Late' }], { withdrawnModels: first.withdrawnModels }),
      source([{ id: 'keep', name: 'Keep' }]),
      LATER
    )
    expect(second.withdrawnModels?.[0]).toEqual({ id: 'late', name: 'Late', at: LATER })
    expect(second.withdrawnModels?.[1]).toEqual({ id: 'm0', name: 'M0', at: AT })
  })

  it('records a replaced account model, but not one re-issued under a new id with the same name', () => {
    const replaced = recordCatalogChange(
      source([{ id: 'old', name: 'Old' }], { model: 'old' }),
      source([{ id: 'auto', name: 'Auto' }], { model: 'auto' }),
      AT
    )
    expect(replaced.modelReplacement).toEqual({ from: 'old', fromName: 'Old', to: 'auto', at: AT })

    const reissued = recordCatalogChange(
      source([{ id: 'kimi-k3-1', name: 'Kimi-K3' }], { model: 'kimi-k3-1', modelReplacement: replaced.modelReplacement }),
      source([{ id: 'kimi-k3-2', name: 'Kimi-K3' }], { model: 'kimi-k3-2', modelReplacement: replaced.modelReplacement }),
      LATER
    )
    expect(reissued.modelReplacement).toBeUndefined()
    expect(reissued.withdrawnModels).toEqual([{ id: 'kimi-k3-1', name: 'Kimi-K3', at: LATER }])
  })

  it('names the old model from the withdrawn list when an earlier sign-in already dropped it', () => {
    const signedIn = source([{ id: 'kimi-k3-2', name: 'Kimi-K3' }], {
      model: 'kimi-k3-1',
      withdrawnModels: [{ id: 'kimi-k3-1', name: 'Kimi-K3', at: AT }]
    })
    const followed = recordCatalogChange(signedIn, source([{ id: 'kimi-k3-2', name: 'Kimi-K3' }], { model: 'kimi-k3-2' }), LATER)
    expect(followed.modelReplacement).toBeUndefined()

    const moved = recordCatalogChange(signedIn, source([{ id: 'auto', name: 'Auto' }], { model: 'auto' }), LATER)
    expect(moved.modelReplacement).toEqual({ from: 'kimi-k3-1', fromName: 'Kimi-K3', to: 'auto', at: LATER })
  })

  it('records no replacement when the account had no model before', () => {
    const next = recordCatalogChange(source([{ id: 'a', name: 'A' }], { model: '' }), source([{ id: 'a', name: 'A' }], { model: 'a' }), AT)
    expect(next.modelReplacement).toBeUndefined()
  })

  it('tolerates an account stored without a model list', () => {
    const missing = { ...source([]), availableModels: undefined } as unknown as AISource
    expect(recordCatalogChange(missing, source([{ id: 'a', name: 'A' }], { model: 'a' }), AT).withdrawnModels).toBeUndefined()
    expect(recordCatalogChange(source([{ id: 'a', name: 'A' }]), missing, AT).withdrawnModels).toEqual([{ id: 'a', name: 'A', at: AT }])
  })

  it('leaves an earlier replacement alone when the account model did not move', () => {
    const earlier = { from: 'old', fromName: 'Old', to: 'a', at: AT }
    const next = recordCatalogChange(
      source([{ id: 'a', name: 'A' }], { model: 'a', modelReplacement: earlier }),
      source([{ id: 'a', name: 'A' }, { id: 'c', name: 'C' }], { model: 'a', modelReplacement: earlier }),
      LATER
    )
    expect(next.modelReplacement).toEqual(earlier)
  })
})
