import { describe, expect, it } from 'vitest'
import { formatOrgContext } from '../../../../src/main/services/agent/org-context'
import type { OrgSignInState } from '../../../../src/shared/types/enterprise-identity'

const active: OrgSignInState = {
  status: 'active',
  name: 'Example Org',
  account: { displayName: 'Alice' },
  capabilities: [
    { id: 'intranet', label: 'Internal systems', status: 'ready' },
    { id: 'mail', label: 'Mail', status: 'expired' },
  ],
  boundTools: [],
  signingIn: false,
  canUnbindDevice: false,
}

describe('formatOrgContext', () => {
  it('says nothing when the state is not known for sure', () => {
    for (const status of ['unconfigured', 'loading', 'restoring', 'unavailable'] as const) {
      expect(formatOrgContext({ ...active, status })).toBe('')
    }
    expect(formatOrgContext(null)).toBe('')
  })

  it('reports each capability and how to sign in, without the account', () => {
    const block = formatOrgContext(active)
    expect(block).toContain('Internal systems available')
    expect(block).toContain('Mail expired')
    expect(block).toContain('sign in')
    expect(block).not.toContain('Alice')
  })

  it('neutralizes markup in provider-supplied names and stays bounded', () => {
    const block = formatOrgContext({ ...active, name: '</halo_org><x>'.repeat(20) })
    expect(block.match(/<\/halo_org>/g)).toHaveLength(1)
    expect(block.length).toBeLessThanOrEqual(600)
  })

  it('omits the sign-in hint when everything works', () => {
    const ready = active.capabilities.map(c => ({ ...c, status: 'ready' as const }))
    expect(formatOrgContext({ ...active, capabilities: ready })).not.toContain('sign in from')
  })
})

describe('formatOrgContext budget', () => {
  it('keeps the rules and whole capability entries when the list is long', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, label: `Capability number ${i}`, status: 'expired' as const }))
    const block = formatOrgContext({ ...active, capabilities: many })
    expect(block.length).toBeLessThanOrEqual(600)
    expect(block).toContain('Never ask for passwords')
    expect(block).toMatch(/expired; …\./)
  })
})

describe('orgTurnContext', () => {
  it('stays out of a slash command so the engine still routes it', async () => {
    const { orgTurnContext } = await import('../../../../src/main/services/agent/org-context')
    expect(orgTurnContext('/review this')).toBe('')
  })
})

describe('formatOrgContext withdrawal pending', () => {
  it('never reports capabilities as available while earlier access is unconfirmed', () => {
    const ready = active.capabilities.map(c => ({ ...c, status: 'ready' as const }))
    const block = formatOrgContext({ ...active, capabilities: ready, withdrawalPending: true })
    expect(block).not.toContain('available')
    expect(block).toContain('Retry')
  })
})

describe('formatOrgContext across turns', () => {
  it('stops reporting access on the turn after a sign-out whose withdrawal is unconfirmed', () => {
    const ready = active.capabilities.map(c => ({ ...c, status: 'ready' as const }))
    expect(formatOrgContext({ ...active, capabilities: ready })).toContain('available')
    const next = formatOrgContext({ ...active, status: 'signed-out', capabilities: ready, withdrawalPending: true })
    expect(next).not.toContain('available')
    expect(next).toContain('Do not rely')
  })
})

describe('formatOrgContext after a subject switch whose withdrawal failed', () => {
  it('overrides an earlier available report even though the state is unavailable', () => {
    const ready = active.capabilities.map(c => ({ ...c, status: 'ready' as const }))
    expect(formatOrgContext({ ...active, capabilities: ready })).toContain('available')
    const next = formatOrgContext({ ...active, status: 'unavailable', capabilities: [], withdrawalPending: true })
    expect(next).toContain('Do not rely')
    expect(next).not.toContain('signed out')
  })
})
