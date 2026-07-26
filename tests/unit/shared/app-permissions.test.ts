/**
 * Unit tests for resolvePermission (shared/apps/app-types) and toSkillDirName
 * (shared/skill-naming).
 *
 * resolvePermission encodes a deliberate product decision: built-in
 * capabilities are enabled by default; a spec's `permissions` list only ADDS
 * capability, and the only way a capability ends up off is an explicit user
 * deny. These tests pin that contract so a future edit cannot silently revert
 * to opt-in semantics (or vice versa) without failing here.
 *
 * toSkillDirName is the specId→directory contract shared by main
 * (manager/skill-sync writes the dir) and renderer (AppSkillsSection matches
 * disk dirs back to installed apps) — drift breaks the match silently.
 */

import { describe, it, expect } from 'vitest'
import { resolvePermission } from '../../../src/shared/apps/app-types'
import { toSkillDirName } from '../../../src/shared/skill-naming'

function makeApp(opts: {
  granted?: string[]
  denied?: string[]
  specPermissions?: string[]
}) {
  return {
    permissions: { granted: opts.granted ?? [], denied: opts.denied ?? [] },
    spec: { permissions: opts.specPermissions } as { permissions?: string[] },
  } as Parameters<typeof resolvePermission>[0]
}

describe('resolvePermission', () => {
  it('explicit user deny always wins', () => {
    const app = makeApp({ denied: ['ai-terminal'], specPermissions: ['ai-terminal'] })
    expect(resolvePermission(app, 'ai-terminal')).toBe(false)
  })

  it('deny wins even over an explicit grant', () => {
    const app = makeApp({ granted: ['email'], denied: ['email'] })
    expect(resolvePermission(app, 'email')).toBe(false)
  })

  it('explicit user grant wins over an undeclared spec', () => {
    const app = makeApp({ granted: ['ai-browser'] })
    expect(resolvePermission(app, 'ai-browser')).toBe(true)
  })

  it('spec declaration enables the permission', () => {
    const app = makeApp({ specPermissions: ['im-push'] })
    expect(resolvePermission(app, 'im-push')).toBe(true)
  })

  it('undeclared permission defaults to true (capabilities on by default)', () => {
    const app = makeApp({})
    expect(resolvePermission(app, 'ai-terminal')).toBe(true)
  })

  it('a spec permissions list does NOT turn off unlisted permissions', () => {
    // Declaring only 'email' must not disable other built-ins (adds-only semantics).
    const app = makeApp({ specPermissions: ['email'] })
    expect(resolvePermission(app, 'ai-terminal')).toBe(true)
    expect(resolvePermission(app, 'ai-browser')).toBe(true)
  })

  it('caller-provided defaultValue applies only when nothing else matches', () => {
    const app = makeApp({})
    expect(resolvePermission(app, 'ai-terminal', false)).toBe(false)
    expect(resolvePermission(makeApp({ specPermissions: ['ai-terminal'] }), 'ai-terminal', false)).toBe(true)
  })

  it('handles a spec without a permissions field', () => {
    const app = makeApp({})
    delete (app.spec as { permissions?: string[] }).permissions
    expect(resolvePermission(app, 'ai-browser')).toBe(true)
  })
})

describe('toSkillDirName', () => {
  it('keeps alphanumerics, dash, and underscore', () => {
    expect(toSkillDirName('my-skill_v2')).toBe('my-skill_v2')
  })

  it('replaces every other character with underscore', () => {
    expect(toSkillDirName('a.b/c d@e')).toBe('a_b_c_d_e')
  })

  it('is idempotent (sanitized output maps to itself)', () => {
    const once = toSkillDirName('vendor/skill.name')
    expect(toSkillDirName(once)).toBe(once)
  })
})
