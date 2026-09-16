/**
 * Tests for file tree vs watcher ignore layering.
 *
 * The tree once inherited the watcher's baseline list and silently hid real
 * source directories named `build` / `dist`. These lock the two rule sets apart.
 */

import { describe, it, expect } from 'vitest'
import { loadTreeIgnoreRules, loadIgnoreRules, isIgnored } from '../../../../src/worker/file-watcher/scanner'

describe('loadTreeIgnoreRules', () => {
  const ig = loadTreeIgnoreRules()

  it('hides VCS metadata', () => {
    expect(isIgnored(ig, '.git')).toBe(true)
    expect(isIgnored(ig, 'pkg/.svn')).toBe(true)
  })

  it('shows build output and dependencies', () => {
    for (const path of ['build', 'dist', 'out', 'node_modules', 'target', 'coverage', 'Pods']) {
      expect(isIgnored(ig, path)).toBe(false)
      expect(isIgnored(ig, `pkg/${path}`)).toBe(false)
    }
  })

  it('shows .halo so the space can browse its own data', () => {
    expect(isIgnored(ig, '.halo')).toBe(false)
  })
})

describe('loadIgnoreRules', () => {
  const ig = loadIgnoreRules('/nonexistent-root-without-gitignore')

  it('still excludes build output from watching and flat scans', () => {
    expect(isIgnored(ig, 'build')).toBe(true)
    expect(isIgnored(ig, 'node_modules')).toBe(true)
    expect(isIgnored(ig, '.halo')).toBe(true)
  })
})
