/**
 * Unit Tests: shared/apps — required-config validation
 *
 * Guards the "is this field filled?" rule shared by the Overview alert, the
 * Settings field markers, and any future main-process validator.
 */

import { describe, it, expect } from 'vitest'
import {
  hasConfigValue,
  resolveConfigValue,
  findMissingRequiredConfig,
} from '../../../src/shared/apps/config-validation'
import type { InputDef } from '../../../src/shared/apps/spec-types'

const requiredUrl: InputDef = { key: 'endpoint', label: 'Endpoint', type: 'url', required: true }
const optionalNote: InputDef = { key: 'note', label: 'Note', type: 'string' }

describe('hasConfigValue', () => {
  it('treats absent values as unfilled', () => {
    expect(hasConfigValue(undefined)).toBe(false)
    expect(hasConfigValue(null)).toBe(false)
  })

  it('treats blank and whitespace-only strings as unfilled', () => {
    expect(hasConfigValue('')).toBe(false)
    expect(hasConfigValue('   ')).toBe(false)
    expect(hasConfigValue('https://example.com')).toBe(true)
  })

  it('keeps false and 0 as legitimate answers', () => {
    expect(hasConfigValue(false)).toBe(true)
    expect(hasConfigValue(0)).toBe(true)
  })

  it('treats an empty list as unfilled', () => {
    expect(hasConfigValue([])).toBe(false)
    expect(hasConfigValue(['a'])).toBe(true)
  })
})

describe('resolveConfigValue', () => {
  it('falls back to the schema default when the user has not set a value', () => {
    const def: InputDef = { ...requiredUrl, default: 'https://default.example' }
    expect(resolveConfigValue(def, {})).toBe('https://default.example')
    expect(resolveConfigValue(def, undefined)).toBe('https://default.example')
  })

  it('prefers the user value over the default', () => {
    const def: InputDef = { ...requiredUrl, default: 'https://default.example' }
    expect(resolveConfigValue(def, { endpoint: 'https://user.example' })).toBe('https://user.example')
  })
})

describe('findMissingRequiredConfig', () => {
  it('returns nothing when there is no schema', () => {
    expect(findMissingRequiredConfig(undefined, {})).toEqual([])
    expect(findMissingRequiredConfig([], { a: 1 })).toEqual([])
  })

  it('ignores optional fields even when empty', () => {
    expect(findMissingRequiredConfig([optionalNote], {})).toEqual([])
  })

  it('reports a required field the user left empty', () => {
    const missing = findMissingRequiredConfig([requiredUrl, optionalNote], { endpoint: '' })
    expect(missing.map(d => d.key)).toEqual(['endpoint'])
  })

  it('counts a schema default as filled, matching what runtime receives', () => {
    const def: InputDef = { ...requiredUrl, default: 'https://default.example' }
    expect(findMissingRequiredConfig([def], {})).toEqual([])
  })

  it('preserves schema order so the UI lists fields as they are rendered', () => {
    const schema: InputDef[] = [
      { key: 'a', label: 'A', type: 'string', required: true },
      optionalNote,
      { key: 'b', label: 'B', type: 'string', required: true },
    ]
    expect(findMissingRequiredConfig(schema, {}).map(d => d.key)).toEqual(['a', 'b'])
  })
})
