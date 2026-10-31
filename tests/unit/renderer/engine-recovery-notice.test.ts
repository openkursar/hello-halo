import { describe, it, expect } from 'vitest'


import { resolveEngineIssue, resolveEngineNotice } from '../../../src/renderer/components/settings/engine-issue'

describe('why a conversation cannot run as configured', () => {
  it('asks a Claude Code login account to connect Claude Code while it is missing', () => {
    expect(resolveEngineIssue({ engine: 'halo', delegated: true, accountCompatible: false, ccAvailable: false })).toBe('account-needs-cc')
    expect(resolveEngineIssue({ engine: 'halo', delegated: true, accountCompatible: false })).toBe('account-needs-cc')
    expect(resolveEngineIssue({ engine: 'anthropic', delegated: true, accountCompatible: true, ccAvailable: false })).toBe('account-needs-cc')
  })

  it('offers to move a Claude Code login account onto Claude Code once it is there', () => {
    expect(resolveEngineIssue({ engine: 'halo', delegated: true, accountCompatible: false, ccAvailable: true })).toBe('account-cc-ready')
    expect(resolveEngineIssue({ engine: 'anthropic', delegated: true, accountCompatible: true, ccAvailable: true })).toBeNull()
  })

  it('tells a conversation on Claude Code that it is missing, only once that is known', () => {
    expect(resolveEngineIssue({ engine: 'anthropic', delegated: false, accountCompatible: true, ccAvailable: false })).toBe('cc-missing')
    expect(resolveEngineIssue({ engine: 'anthropic', delegated: false, accountCompatible: true })).toBeNull()
    expect(resolveEngineIssue({ engine: 'halo', delegated: false, accountCompatible: true, ccAvailable: false })).toBeNull()
  })

  it('keeps the Codex account explanation', () => {
    expect(resolveEngineIssue({ engine: 'codex', delegated: false, accountCompatible: false })).toBe('codex-account')
  })
})

describe('which note an engine failure gets', () => {
  it('an old conversation still on Claude Code while the chat resolves Halo SDK: the general note', () => {
    const issue = resolveEngineIssue({ engine: 'halo', delegated: false, accountCompatible: true, ccAvailable: false })
    expect(resolveEngineNotice({ issue, failed: true, fellBack: false, dismissed: false })).toEqual({ kind: 'failure' })
  })

  it('Claude Code gone after an earlier read said it was there: the reread names it, and without one the general note remains', () => {
    const stale = resolveEngineIssue({ engine: 'anthropic', delegated: false, accountCompatible: true, ccAvailable: true })
    expect(resolveEngineNotice({ issue: stale, failed: true, fellBack: false, dismissed: false })).toEqual({ kind: 'failure' })
    const reread = resolveEngineIssue({ engine: 'anthropic', delegated: false, accountCompatible: true, ccAvailable: false })
    expect(resolveEngineNotice({ issue: reread, failed: true, fellBack: false, dismissed: false })).toEqual({ kind: 'issue', issue: 'cc-missing' })
  })

  it('Claude Code passes its check but cannot be loaded: the general note, even if the fallback note was hidden', () => {
    const issue = resolveEngineIssue({ engine: 'anthropic', delegated: false, accountCompatible: true, ccAvailable: true })
    expect(resolveEngineNotice({ issue, failed: true, fellBack: true, dismissed: true })).toEqual({ kind: 'failure' })
  })

  it('shows nothing new without a failure', () => {
    expect(resolveEngineNotice({ issue: null, failed: false, fellBack: false, dismissed: false })).toBeNull()
    expect(resolveEngineNotice({ issue: null, failed: false, fellBack: true, dismissed: true })).toBeNull()
    expect(resolveEngineNotice({ issue: null, failed: false, fellBack: true, dismissed: false })).toEqual({ kind: 'fell-back' })
  })
})
