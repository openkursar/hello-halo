/**
 * Unit tests for imported-package path resolution.
 *
 * Skill parsing, digital-human parsing and type detection all resolve the
 * package root through this module. Each used to carry its own copy, and the
 * copies drifted — so these cases pin the behaviour every importer now shares.
 */

import { describe, it, expect } from 'vitest'
import {
  isIgnoredPackagePath,
  wrapperPrefix,
  findPackageEntry,
  canonicalizePackageEntry,
  unwrapPackageFolder,
} from '../../../src/renderer/components/apps/package-paths'

describe('isIgnoredPackagePath', () => {
  it('ignores directory records', () => {
    expect(isIgnoredPackagePath('skills/')).toBe(true)
  })

  it('ignores the metadata macOS adds when compressing', () => {
    expect(isIgnoredPackagePath('__MACOSX/._SKILL.md')).toBe(true)
    expect(isIgnoredPackagePath('pkg/.DS_Store')).toBe(true)
    expect(isIgnoredPackagePath('pkg/._SKILL.md')).toBe(true)
  })

  it('keeps real content', () => {
    expect(isIgnoredPackagePath('SKILL.md')).toBe(false)
    expect(isIgnoredPackagePath('skills/a/SKILL.md')).toBe(false)
  })
})

describe('wrapperPrefix', () => {
  it('reports no wrapper for a flat package', () => {
    expect(wrapperPrefix(['SKILL.md', 'index.js'])).toBe('')
  })

  it('reports the wrapper a compressed folder adds', () => {
    expect(wrapperPrefix(['pkg/SKILL.md', 'pkg/skills/a/SKILL.md'])).toBe('pkg/')
  })

  it('treats a half-nested package as flat rather than dropping a root file', () => {
    expect(wrapperPrefix(['pkg', 'pkg/SKILL.md'])).toBe('')
  })
})

describe('findPackageEntry', () => {
  it('finds an entry however it is cased', () => {
    expect(findPackageEntry(['skill.md'], 'SKILL.md')).toBe('skill.md')
    expect(findPackageEntry(['Skill.MD'], 'SKILL.md')).toBe('Skill.MD')
  })

  it('prefers the exact spelling when both are present', () => {
    expect(findPackageEntry(['skill.md', 'SKILL.md'], 'SKILL.md')).toBe('SKILL.md')
  })

  it('does not reach into subdirectories', () => {
    expect(findPackageEntry(['skills/a/SKILL.md'], 'SKILL.md')).toBeUndefined()
  })
})

describe('canonicalizePackageEntry', () => {
  it('re-keys a misspelled entry file', () => {
    expect(canonicalizePackageEntry({ 'skill.md': 'a', 'run.py': 'b' }, 'SKILL.md'))
      .toEqual({ 'SKILL.md': 'a', 'run.py': 'b' })
  })

  it('returns the tree untouched when the entry is already canonical', () => {
    const files = { 'SKILL.md': 'a' }
    expect(canonicalizePackageEntry(files, 'SKILL.md')).toBe(files)
  })

  it('drops a variant sitting beside the exact entry', () => {
    // Both resolve to one file on a case-insensitive filesystem, so carrying
    // the variant lets whichever is written last decide the content.
    expect(canonicalizePackageEntry({ 'skill.md': 'variant', 'SKILL.md': 'real' }, 'SKILL.md'))
      .toEqual({ 'SKILL.md': 'real' })
  })

  it('leaves a tree with no entry file alone', () => {
    const files = { 'readme.md': 'a' }
    expect(canonicalizePackageEntry(files, 'SKILL.md')).toBe(files)
  })
})

describe('unwrapPackageFolder', () => {
  it('re-keys a wrapped package against its root', () => {
    expect(unwrapPackageFolder({
      'my-skill/SKILL.md': 'a',
      'my-skill/references/guide.md': 'b',
    })).toEqual({
      'SKILL.md': 'a',
      'references/guide.md': 'b',
    })
  })

  it('leaves a flat package alone', () => {
    expect(unwrapPackageFolder({ 'SKILL.md': 'a', 'index.js': 'b' }))
      .toEqual({ 'SKILL.md': 'a', 'index.js': 'b' })
  })

  it('drops ignored entries before deciding on the wrapper', () => {
    // Without the filter running first, __MACOSX/ reads as a second top-level
    // folder and the real wrapper is left in place.
    expect(unwrapPackageFolder({
      '__MACOSX/': '',
      '__MACOSX/._SKILL.md': 'junk',
      'my-skill/': '',
      'my-skill/.DS_Store': 'junk',
      'my-skill/SKILL.md': 'a',
    })).toEqual({ 'SKILL.md': 'a' })
  })
})
