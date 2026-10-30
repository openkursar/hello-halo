import { beforeEach, describe, expect, it, vi } from 'vitest'

const product = vi.hoisted(() => ({ source: undefined as { name?: string; baseUrl: string } | undefined }))
vi.mock('../../../src/main/foundation/product-config', () => ({ getClaudeCodeDownloadSource: () => product.source }))

import { getEffectiveSourceId, getSources, validatePreferences, validateSource } from '../../../src/main/services/cc-runtime/sources'

describe('Claude Code download sources', () => {
  beforeEach(() => { product.source = undefined })

  it('uses the official source when the build declares none', () => {
    expect(getSources().map(source => source.id)).toEqual(['official'])
    expect(getEffectiveSourceId()).toBe('official')
  })

  it('offers and preselects the build\'s own source', () => {
    product.source = { name: 'Intranet mirror', baseUrl: 'http://mirror.example.com/claude-code-releases/' }
    expect(getSources()).toEqual([
      expect.objectContaining({ id: 'official' }),
      { id: 'preset', name: 'Intranet mirror', baseUrl: 'http://mirror.example.com/claude-code-releases' },
    ])
    expect(getEffectiveSourceId()).toBe('preset')
  })

  it('keeps a source the user chose', () => {
    product.source = { baseUrl: 'http://mirror.example.com/cc' }
    expect(getEffectiveSourceId({ sourceId: 'official' })).toBe('official')
    const custom = { id: 'custom', name: 'Mine', baseUrl: 'https://cc.example.org' }
    expect(getEffectiveSourceId({ sources: [custom], sourceId: 'custom' })).toBe('custom')
  })

  it('falls back when a remembered source no longer exists', () => {
    expect(getEffectiveSourceId({ sourceId: 'preset' })).toBe('official')
  })

  it('never stores the build\'s source with the user\'s own', () => {
    product.source = { baseUrl: 'http://mirror.example.com/cc' }
    const saved = validatePreferences({ sources: [...getSources(), { id: 'custom', name: 'Mine', baseUrl: 'https://cc.example.org' }], sourceId: 'preset' })
    expect(saved.sources?.map(source => source.id)).toEqual(['official', 'custom'])
    expect(saved.sourceId).toBe('preset')
  })

  it('ignores a declared source that is not a plain HTTP(S) URL, saying so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    product.source = { baseUrl: 'https://user:secret@mirror.example.com/cc' }
    expect(getSources().map(source => source.id)).toEqual(['official'])
    expect(getEffectiveSourceId()).toBe('official')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('leaves an unnamed build source unnamed, for Settings to name, and still valid wherever it is checked again', () => {
    product.source = { baseUrl: 'http://mirror.example.com/cc' }
    expect(getSources()[1]).toEqual({ id: 'preset', name: '', baseUrl: 'http://mirror.example.com/cc' })
    expect(validateSource(getSources()[1])).toEqual(getSources()[1])
  })

  it('still requires a name of every other source', () => {
    expect(() => validateSource({ id: 'custom', name: ' ', baseUrl: 'https://cc.example.org' })).toThrow()
    expect(() => validateSource({ id: 'official', name: '', baseUrl: 'https://cc.example.org' })).toThrow()
  })
})
