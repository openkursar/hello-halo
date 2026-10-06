/**
 * Unit tests for resolveLocalizedText in shared/types/ai-sources.ts.
 *
 * Fallback chain (documented on the function):
 *   plain string -> exact locale -> prefix match -> 'en' -> first value -> ''.
 */

import { describe, it, expect } from 'vitest'
import { resolveLocalizedText, getModelDisplayName, getSourceAccountName, type AISource, type AISourcesConfig } from '../../../src/shared/types/ai-sources'

describe('strict model selection display', () => {
  const source = (id: string): AISource => ({
    id, name: id, provider: 'custom', authType: 'api-key', apiUrl: '', model: `${id}-model`,
    availableModels: [{ id: `${id}-model`, name: `${id} model` }], createdAt: '', updatedAt: '',
  })
  const config: AISourcesConfig = { version: 2, currentId: 'b', sources: [source('a'), source('b')] }
  it('follows global only without a source pin', () => {
    expect(getModelDisplayName(config)).toBe('b model')
    expect(getModelDisplayName(config, 'a')).toBe('a model')
    expect(getModelDisplayName(config, 'a', 'custom-model')).toBe('custom-model')
  })
  it('never labels a deleted pin as a different account, including when every account was deleted', () => {
    expect(getModelDisplayName(config, 'removed', 'old-model')).toBe('')
    expect(getModelDisplayName({ version: 2, currentId: null, sources: [] }, 'a')).toBe('')
    expect(config.currentId).toBe('b')
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
