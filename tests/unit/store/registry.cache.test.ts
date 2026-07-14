/**
 * registry.cache unit tests.
 *
 * Exercises the on-disk index/spec cache against the per-test sandbox home
 * (electron + os are mocked in setup.ts, so getHaloDir resolves under it).
 * Covers roundtrip + fetchedAt, corrupt-JSON tolerance (returns null, no throw),
 * cache path building under {haloDir}/store-cache/{registryId}, and clear.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'

import {
  getCacheDir,
  readCachedIndex,
  writeCachedIndex,
  readCachedSpec,
  writeCachedSpec,
  clearCache,
} from '../../../src/main/store/registry.cache'
import { getHaloDir } from '../../../src/main/foundation/config.service'
import type { RegistryIndex } from '../../../src/shared/store/store-types'
import type { AppSpec } from '../../../src/main/apps/spec/schema'

function makeIndex(): RegistryIndex {
  return {
    version: 1,
    generated_at: '2026-02-24T00:00:00.000Z',
    source: 'https://example.com/reg',
    apps: [],
  }
}

function makeSpec(): AppSpec {
  return {
    name: 'Cache App',
    version: '1.0.0',
    author: 'tester',
    description: 'd',
    type: 'automation',
    system_prompt: 'run',
  } as unknown as AppSpec
}

describe('registry.cache', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('builds the cache dir under {haloDir}/store-cache', () => {
    const dir = getCacheDir()
    expect(dir).toBe(join(getHaloDir(), 'store-cache'))
    expect(existsSync(dir)).toBe(true)
  })

  it('roundtrips an index and records fetchedAt', () => {
    const before = Date.now()
    writeCachedIndex('reg-1', makeIndex())

    const cached = readCachedIndex('reg-1')
    expect(cached).not.toBeNull()
    expect(cached!.registryId).toBe('reg-1')
    expect(cached!.index.source).toBe('https://example.com/reg')
    expect(cached!.fetchedAt).toBeGreaterThanOrEqual(before)
  })

  it('roundtrips a spec keyed by registry:slug', () => {
    writeCachedSpec('reg-1', 'cache-app', makeSpec())

    const cached = readCachedSpec('reg-1', 'cache-app')
    expect(cached).not.toBeNull()
    expect(cached!.key).toBe('reg-1:cache-app')
    expect(cached!.spec.version).toBe('1.0.0')
  })

  it('returns null when no cache exists', () => {
    expect(readCachedIndex('missing')).toBeNull()
    expect(readCachedSpec('missing', 'slug')).toBeNull()
  })

  it('tolerates a corrupt index JSON (returns null, no throw)', () => {
    // Seed valid meta but garbage index content.
    writeCachedIndex('reg-corrupt', makeIndex())
    const indexPath = join(getCacheDir(), 'reg-corrupt', 'index.json')
    writeFileSync(indexPath, '{ not valid json')

    expect(() => readCachedIndex('reg-corrupt')).not.toThrow()
    expect(readCachedIndex('reg-corrupt')).toBeNull()
  })

  it('clears a single registry cache without touching others', () => {
    writeCachedIndex('keep', makeIndex())
    writeCachedIndex('drop', makeIndex())

    clearCache('drop')

    expect(existsSync(join(getCacheDir(), 'drop'))).toBe(false)
    expect(readCachedIndex('keep')).not.toBeNull()
  })

  it('clears the entire cache when no registry id is given', () => {
    writeCachedIndex('a', makeIndex())
    writeCachedIndex('b', makeIndex())

    clearCache()

    expect(readCachedIndex('a')).toBeNull()
    expect(readCachedIndex('b')).toBeNull()
  })
})
