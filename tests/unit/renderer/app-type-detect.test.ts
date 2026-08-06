/**
 * Unit tests for import package classification.
 *
 * The regression that motivated these: Halo ships a skill with a `spec.yaml`
 * of its own metadata next to SKILL.md, and the old detector treated any
 * spec.yaml as a digital-human marker — so every Halo skill package was
 * classified as a digital human and rejected by the wrong validator.
 */

import { describe, it, expect } from 'vitest'
import { detectAppType } from '../../../src/renderer/components/apps/app-type-detect'

describe('detectAppType', () => {
  it('classifies a skill by its root SKILL.md', () => {
    expect(detectAppType(['SKILL.md'])).toBe('skill')
  })

  it('keeps classifying a skill when Halo metadata rides along', () => {
    expect(detectAppType(['SKILL.md', 'index.js', 'spec.yaml'])).toBe('skill')
  })

  it('classifies a digital human by its root spec.yaml', () => {
    expect(detectAppType(['spec.yaml'])).toBe('automation')
    expect(detectAppType(['spec.yml'])).toBe('automation')
  })

  it('does not mistake a digital human for a skill via its bundled skills', () => {
    expect(detectAppType(['spec.yaml', 'skills/a/SKILL.md', 'skills/b/SKILL.md'])).toBe('automation')
  })

  it('sees through a single wrapping folder', () => {
    expect(detectAppType(['my-skill/SKILL.md', 'my-skill/spec.yaml'])).toBe('skill')
    expect(detectAppType(['my-dh/spec.yaml', 'my-dh/skills/a/SKILL.md'])).toBe('automation')
  })

  it('does not strip a top-level segment that is a root file', () => {
    expect(detectAppType(['SKILL.md', 'references/guide.md'])).toBe('skill')
  })

  it('ignores macOS metadata and directory entries', () => {
    expect(detectAppType([
      '__MACOSX/',
      '__MACOSX/._SKILL.md',
      'my-skill/',
      'my-skill/.DS_Store',
      'my-skill/SKILL.md',
    ])).toBe('skill')
  })

  it('places a skill whose entry file is misspelled in lower case', () => {
    expect(detectAppType(['skill.md'])).toBe('skill')
    expect(detectAppType(['my-skill/Skill.md', 'my-skill/scripts/run.py'])).toBe('skill')
  })

  it('matches spec.yaml exactly, as the digital-human parser does', () => {
    expect(detectAppType(['Spec.yaml'])).toBeNull()
  })

  it('returns null for a package it cannot place', () => {
    expect(detectAppType([])).toBeNull()
    expect(detectAppType(['readme.md', 'src/index.ts'])).toBeNull()
    expect(detectAppType(['nested/deep/SKILL.md'])).toBeNull()
  })
})
