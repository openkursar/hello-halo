/**
 * Unit tests for the local publish pre-flight (FR-4.3).
 *
 * The rules are pure — secret shapes block, version must exceed the published
 * version, name is required, description is advisory — so they are asserted
 * directly without any renderer scaffolding.
 */

import { describe, it, expect } from 'vitest'
import { runPublishPreflight } from '../../../src/renderer/components/store/publish-preflight'
import type { AutomationSpec, SkillSpec } from '../../../src/shared/apps/spec-types'

function automation(overrides: Partial<AutomationSpec> = {}): AutomationSpec {
  return {
    spec_version: '1',
    type: 'automation',
    name: 'Helper',
    version: '1.0.0',
    author: 'ada',
    description: 'Does a thing',
    system_prompt: 'You are helpful.',
    ...overrides,
  }
}

function skill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    spec_version: '1',
    type: 'skill',
    name: 'Formatter',
    version: '1.0.0',
    description: 'Formats text',
    skill_files: { 'SKILL.md': '# Formatter\nDoes formatting.' },
    ...overrides,
  }
}

describe('runPublishPreflight', () => {
  it('passes a clean automation spec with no store version', () => {
    expect(runPublishPreflight({ spec: automation() })).toEqual([])
  })

  it('flags an Anthropic key pasted into the system prompt', () => {
    const spec = automation({ system_prompt: 'Use key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV to call.' })
    const findings = runPublishPreflight({ spec })
    expect(findings).toContainEqual(expect.objectContaining({ severity: 'error', code: 'secret-detected', detail: 'Anthropic API key' }))
  })

  it('scans skill file contents for secrets', () => {
    const spec = skill({ skill_files: { 'SKILL.md': 'token AKIAIOSFODNN7EXAMPLE here' } })
    const findings = runPublishPreflight({ spec })
    expect(findings.some(f => f.code === 'secret-detected' && f.detail === 'AWS access key')).toBe(true)
  })

  it('does not report the same secret kind twice', () => {
    const spec = skill({ skill_files: { 'a.md': 'sk-ant-aaaaaaaaaaaaaaaaaaaaaa', 'b.md': 'sk-ant-bbbbbbbbbbbbbbbbbbbbbb' } })
    const findings = runPublishPreflight({ spec }).filter(f => f.code === 'secret-detected')
    expect(findings).toHaveLength(1)
  })

  it('blocks when the local version is not higher than the published version', () => {
    const findings = runPublishPreflight({ spec: automation({ version: '1.0.0' }), storeVersion: '1.0.0' })
    expect(findings).toContainEqual(expect.objectContaining({ code: 'version-not-incremented' }))
  })

  it('allows a strictly higher version', () => {
    const findings = runPublishPreflight({ spec: automation({ version: '1.0.1' }), storeVersion: '1.0.0' })
    expect(findings.some(f => f.code === 'version-not-incremented')).toBe(false)
  })

  it('skips the version check when unpublished (storeVersion null)', () => {
    const findings = runPublishPreflight({ spec: automation({ version: '0.0.1' }), storeVersion: null })
    expect(findings.some(f => f.code === 'version-not-incremented')).toBe(false)
  })

  it('validates the overridden name/description, not the spec values (DM-8)', () => {
    const findings = runPublishPreflight({ spec: automation(), overrideName: '  ', overrideDescription: '' })
    expect(findings).toContainEqual(expect.objectContaining({ severity: 'error', code: 'missing-name' }))
    expect(findings).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'missing-description' }))
  })
})
