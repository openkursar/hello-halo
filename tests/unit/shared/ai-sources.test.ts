/**
 * Unit tests for resolveLocalizedText in shared/types/ai-sources.ts.
 *
 * Fallback chain (documented on the function):
 *   plain string -> exact locale -> prefix match -> 'en' -> first value -> ''.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveLocalizedText, getModelDisplayName, resolveModelSelection, getSourceAccountName,
  findWithdrawnModel, activeModelReplacement, MODEL_REPLACEMENT_NOTICE_MS,
  type AISource, type AISourcesConfig,
} from '../../../src/shared/types/ai-sources'

describe('stored model selection display', () => {
  const source = (id: string): AISource => ({
    id, name: id, provider: 'custom', authType: 'api-key', apiUrl: '', model: `${id}-model`,
    availableModels: [{ id: `${id}-model`, name: `${id} model` }], createdAt: '', updatedAt: '',
  })
  const config: AISourcesConfig = { version: 2, currentId: 'b', sources: [source('a'), source('b')] }
  const empty: AISourcesConfig = { version: 2, currentId: null, sources: [] }

  it('shows the pinned account and model when the account exists', () => {
    expect(getModelDisplayName(config, 'a')).toBe('a model')
    expect(getModelDisplayName(config, 'a', 'custom-model')).toBe('custom-model')
    expect(resolveModelSelection(config, { modelSourceId: 'a', modelId: 'custom-model' }))
      .toEqual({ source: config.sources[0], modelId: 'custom-model', own: true })
  })

  it('shows the global selection without a pin', () => {
    expect(getModelDisplayName(config)).toBe('b model')
    expect(resolveModelSelection(config, null)).toEqual({ source: config.sources[1], modelId: 'b-model', own: false })
    expect(resolveModelSelection(config, {}).own).toBe(false)
  })

  it('shows the global selection and its own model for a pin whose account was removed', () => {
    expect(getModelDisplayName(config, 'removed', 'old-model')).toBe('b model')
    expect(resolveModelSelection(config, { modelSourceId: 'removed', modelId: 'old-model' }))
      .toEqual({ source: config.sources[1], modelId: 'b-model', own: false })
    expect(config.currentId).toBe('b')
  })

  it('shows no model when there is no account to run on', () => {
    expect(getModelDisplayName(empty, 'a')).toBe('No model')
    expect(getModelDisplayName(empty)).toBe('No model')
    expect(resolveModelSelection(empty, { modelSourceId: 'a' })).toEqual({ source: null, modelId: undefined, own: false })
  })
})

describe('getSourceAccountName', () => {
  const source = (authType: AISource['authType']): AISource => ({
    id: authType, name: authType, provider: 'p', authType, apiUrl: '', model: 'm',
    availableModels: [], createdAt: '', updatedAt: '', user: { name: 'me@example.com' },
  })

  it('names the signed-in account of sources that sign in, the Claude Code CLI included', () => {
    expect(getSourceAccountName(source('oauth'))).toBe('me@example.com')
    expect(getSourceAccountName(source('delegated'))).toBe('me@example.com')
  })

  it('names none for an API key source', () => {
    expect(getSourceAccountName(source('api-key'))).toBeUndefined()
  })
})

describe('resolveLocalizedText', () => {
  it('returns a plain string verbatim, ignoring the locale', () => {
    expect(resolveLocalizedText('Hello', 'zh-CN')).toBe('Hello')
  })

  it('returns the exact-locale value when present', () => {
    const text = { 'en': 'Hello', 'zh-CN': '你好' }
    expect(resolveLocalizedText(text, 'zh-CN')).toBe('你好')
  })

  it('falls back to a prefix match (zh-TW -> zh)', () => {
    const text = { 'en': 'Hello', 'zh': '你好' }
    expect(resolveLocalizedText(text, 'zh-TW')).toBe('你好')
  })

  it('falls back to "en" when neither exact nor prefix match', () => {
    const text = { 'en': 'Hello', 'ja': 'こんにちは' }
    expect(resolveLocalizedText(text, 'fr-FR')).toBe('Hello')
  })

  it('falls back to the first value when "en" is absent', () => {
    const text = { 'ja': 'こんにちは', 'ko': '안녕하세요' }
    expect(resolveLocalizedText(text, 'fr-FR')).toBe('こんにちは')
  })

  it('returns empty string for an empty object', () => {
    expect(resolveLocalizedText({}, 'en')).toBe('')
  })

  it('prefers exact match over prefix match', () => {
    const text = { 'zh': 'generic zh', 'zh-CN': 'simplified' }
    expect(resolveLocalizedText(text, 'zh-CN')).toBe('simplified')
  })
})

describe('models the vendor withdrew', () => {
  const at = '2026-10-21T10:00:00.000Z'
  const account: AISource = {
    id: 't', name: 'Vendor account', provider: 'vendor-oauth', authType: 'oauth', apiUrl: '', model: 'auto',
    availableModels: [{ id: 'auto', name: 'Auto' }, { id: 'back', name: 'Back' }], createdAt: '', updatedAt: '',
    withdrawnModels: [{ id: 'gone', name: 'Gone model', at }, { id: 'back', name: 'Back', at }],
    modelReplacement: { from: 'gone', fromName: 'Gone model', to: 'auto', at }
  }
  const config: AISourcesConfig = { version: 2, currentId: 't', sources: [account] }

  it('names a pinned withdrawn model by its last known name', () => {
    expect(getModelDisplayName(config, 't', 'gone')).toBe('Gone model')
    expect(getModelDisplayName(config, 't', 'never-listed')).toBe('never-listed')
  })

  it('reports a model as withdrawn only while the catalog does not list it', () => {
    expect(findWithdrawnModel(account, 'gone')).toEqual({ id: 'gone', name: 'Gone model', at })
    expect(findWithdrawnModel(account, 'back')).toBeUndefined()
    expect(findWithdrawnModel(account, undefined)).toBeUndefined()
    expect(findWithdrawnModel({ ...account, availableModels: undefined } as unknown as AISource, 'gone')?.name).toBe('Gone model')
  })

  it('mentions a replacement for a week, and only while the account still uses the model it moved to', () => {
    const start = Date.parse(at)
    expect(activeModelReplacement(account, start + 1000)).toEqual(account.modelReplacement)
    expect(activeModelReplacement(account, start + MODEL_REPLACEMENT_NOTICE_MS)).toBeUndefined()
    expect(activeModelReplacement({ ...account, model: 'back' }, start + 1000)).toBeUndefined()
    expect(activeModelReplacement({ ...account, modelReplacement: { ...account.modelReplacement!, at: 'bad' } }, start)).toBeUndefined()
  })
})
