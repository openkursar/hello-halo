/**
 * Unit tests for the updater's version precedence rules.
 *
 * This comparator decides whether the app replaces its own binaries, so the
 * cases below deliberately include the exact shapes this product ships
 * (`2.1.16-dev.0-rc.7`) alongside the semver spec's own ordering example.
 */

import { describe, it, expect } from 'vitest'
import { compareVersions, isUpgrade, parseVersion } from '../../../../src/main/services/updater/version'

describe('parseVersion', () => {
  it('accepts plain and prerelease versions', () => {
    expect(parseVersion('2.1.16')).toEqual({ major: 2, minor: 1, patch: 16, prerelease: [] })
    expect(parseVersion('2.1.16-rc.7')?.prerelease).toEqual(['rc', '7'])
    expect(parseVersion('2.1.16-dev.0-rc.7')?.prerelease).toEqual(['dev', '0-rc', '7'])
  })

  it('tolerates a leading v and ignores build metadata', () => {
    expect(parseVersion('v2.1.16')?.major).toBe(2)
    expect(parseVersion('2.1.16+build.5')?.prerelease).toEqual([])
  })

  it('rejects strings that are not versions', () => {
    for (const bad of ['', '2.1', 'latest', '2.1.x', '2.1.16-', '2.1.16-rc..1', 'nightly-2.1.16']) {
      expect(parseVersion(bad), bad).toBeNull()
    }
  })
})

describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareVersions('2.1.16', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('2.1.16', '2.2.0')).toBeLessThan(0)
    expect(compareVersions('2.1.16', '2.1.17')).toBeLessThan(0)
    expect(compareVersions('2.1.16', '2.1.16')).toBe(0)
  })

  it('ranks a release above its own prereleases', () => {
    expect(compareVersions('2.1.16', '2.1.16-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('2.1.16-rc.1', '2.1.16')).toBeLessThan(0)
  })

  it('compares numeric prerelease identifiers as numbers, not text', () => {
    // The whole point: string comparison would put rc.10 before rc.9.
    expect(compareVersions('2.1.16-rc.10', '2.1.16-rc.9')).toBeGreaterThan(0)
    expect(compareVersions('2.1.16-rc.2', '2.1.16-rc.10')).toBeLessThan(0)
  })

  it('handles the version shape this product ships', () => {
    expect(compareVersions('2.1.16-dev.0-rc.8', '2.1.16-dev.0-rc.7')).toBeGreaterThan(0)
    expect(compareVersions('2.1.17-dev.0-rc.1', '2.1.16-dev.0-rc.7')).toBeGreaterThan(0)
    expect(compareVersions('2.1.16-dev.0-rc.7', '2.1.16-dev.0-rc.7')).toBe(0)
  })

  it('follows the ordering given in the semver spec', () => {
    const ascending = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]
    for (let i = 1; i < ascending.length; i++) {
      expect(compareVersions(ascending[i], ascending[i - 1]), `${ascending[i]} > ${ascending[i - 1]}`)
        .toBeGreaterThan(0)
    }
  })

  it('throws rather than guessing at unreadable input', () => {
    expect(() => compareVersions('latest', '2.1.16')).toThrow()
  })
})

describe('isUpgrade', () => {
  it('accepts only strictly newer versions', () => {
    expect(isUpgrade('2.1.17', '2.1.16')).toBe(true)
    expect(isUpgrade('2.1.16', '2.1.16')).toBe(false)
    expect(isUpgrade('2.1.15', '2.1.16')).toBe(false)
  })

  it('refuses an update whose version cannot be read', () => {
    // An unreadable feed is not grounds for replacing the running app.
    expect(isUpgrade('who-knows', '2.1.16')).toBe(false)
    expect(isUpgrade('2.1.17', 'who-knows')).toBe(false)
  })
})
