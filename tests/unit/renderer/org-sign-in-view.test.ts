import { describe, expect, it } from 'vitest'
import { joinLabels, orgIndicatorView, organizationOptionIndex, orgSettingsPlacement, orgSignInCardView } from '../../../src/renderer/components/org-sign-in/org-sign-in-view'
import type { OrgSignInState } from '../../../src/shared/types/enterprise-identity'

const base: OrgSignInState = {
  status: 'active',
  name: 'Example Org',
  capabilities: [
    { id: 'intranet', label: 'Internal systems', status: 'ready' },
    { id: 'mail', label: 'Mail', status: 'expired' },
  ],
  boundTools: [],
  signingIn: false,
  canUnbindDevice: false,
}

describe('orgSignInCardView', () => {
  it('never presents incomplete withdrawal as signed out or as no tool access', () => {
    const state: OrgSignInState = {
      ...base, status: 'signed-out', withdrawalPending: true,
      boundTools: [{ toolId: 'org-tool', capability: 'mail', access: 'maybe-still-valid' }],
    }
    expect(orgSignInCardView(state, false, true)).toMatchObject({
      status: 'withdrawal-pending', notice: 'withdrawal', offerRetry: true, offerSignIn: false,
      tools: [{ access: 'maybe-still-valid' }],
    })
    expect(orgIndicatorView(state, true)).toMatchObject({ notice: 'withdrawal', clickSignsIn: false, offerRetry: true })
    expect(orgSignInCardView({ ...state, withdrawalPending: undefined, boundTools: [] }, false, true).status).toBe('signed-out')
  })

  it('offers recovery for initial read, temporary availability, or issuance failure, but not incompatibility', () => {
    const ready = base.capabilities.map(c => ({ ...c, status: 'ready' as const }))
    expect(orgSignInCardView(null, true, true)).toMatchObject({ available: true, notice: 'read-failed', offerRetry: true })
    expect(orgSignInCardView({ ...base, status: 'unavailable', unavailableReason: 'temporary' }, false, true)).toMatchObject({ notice: 'temporary', offerRetry: true })
    expect(orgSignInCardView({ ...base, status: 'unavailable', unavailableReason: 'incompatible' }, false, true)).toMatchObject({ notice: 'incompatible', offerRetry: false })
    expect(orgSignInCardView({ ...base, capabilities: ready, credentialFailed: true }, false, true)).toMatchObject({ notice: 'issue-failed', offerRetry: true, offerSignIn: false })
  })
})

describe('orgIndicatorView', () => {
  it('hides when the build has no organization sign-in', () => {
    expect(orgIndicatorView({ ...base, status: 'unconfigured' }, true).tone).toBe('hidden')
    expect(orgIndicatorView(null, true).tone).toBe('hidden')
  })

  it('never warns while loading or restoring', () => {
    expect(orgIndicatorView({ ...base, status: 'restoring' }, true).tone).toBe('pending')
    expect(orgIndicatorView({ ...base, status: 'loading' }, true).tone).toBe('pending')
  })

  it('names only the capability that needs signing in again', () => {
    const view = orgIndicatorView(base, true)
    expect(view.tone).toBe('attention')
    expect(view.expired.map(c => c.id)).toEqual(['mail'])
    expect(view.working.map(c => c.id)).toEqual(['intranet'])
    expect(view.clickSignsIn).toBe(false)
  })

  it('signs in on click only when signed out on the desktop', () => {
    expect(orgIndicatorView({ ...base, status: 'signed-out' }, true).clickSignsIn).toBe(true)
    expect(orgIndicatorView({ ...base, status: 'signed-out' }, false).clickSignsIn).toBe(false)
    expect(orgIndicatorView({ ...base, status: 'signed-out', signingIn: true }, true).clickSignsIn).toBe(false)
  })

  it('is quiet when everything works', () => {
    const ready = base.capabilities.map(c => ({ ...c, status: 'ready' as const }))
    expect(orgIndicatorView({ ...base, capabilities: ready }, true).tone).toBe('ok')
  })

  it('stays quiet when some capabilities were simply never obtained', () => {
    const caps = [base.capabilities[0], { id: 'mail', label: 'Mail', status: 'missing' as const }]
    expect(orgIndicatorView({ ...base, capabilities: caps }, true).tone).toBe('ok')
    expect(orgSignInCardView({ ...base, capabilities: caps }, false, true).offerSignIn).toBe(false)
  })

  it('treats all expired like signed out', () => {
    const caps = base.capabilities.map(c => ({ ...c, status: 'expired' as const }))
    const view = orgIndicatorView({ ...base, capabilities: caps }, true)
    expect(view.tone).toBe('attention')
    expect(view.clickSignsIn).toBe(true)
  })

  it('stays muted when the component is unavailable', () => {
    expect(orgIndicatorView({ ...base, status: 'unavailable' }, true).tone).toBe('muted')
  })
})

describe('the sign-in among the AI model accounts', () => {
  const signedOut: OrgSignInState = { ...base, status: 'signed-out', capabilities: base.capabilities.map(c => ({ ...c, status: 'missing' as const })) }

  it('is a login option while signed out on the desktop, and absent from a remote client', () => {
    expect(orgSettingsPlacement(signedOut, false, true, false)).toBe('option')
    expect(orgSettingsPlacement(signedOut, false, false, false)).toBe('none')
  })

  it('is a card once there is anything to show or manage', () => {
    expect(orgSettingsPlacement(base, false, true, false)).toBe('card')
    expect(orgSettingsPlacement({ ...base, status: 'restoring' }, false, true, false)).toBe('card')
    expect(orgSettingsPlacement({ ...base, status: 'unavailable', unavailableReason: 'temporary' }, false, true, false)).toBe('card')
    expect(orgSettingsPlacement({ ...signedOut, withdrawalPending: true }, false, true, false)).toBe('card')
    expect(orgSettingsPlacement(null, true, true, false)).toBe('card')
  })

  it('keeps the model account it brought inside the card, whatever the sign-in state', () => {
    expect(orgSettingsPlacement(signedOut, false, true, true)).toBe('card')
    expect(orgSettingsPlacement(null, false, true, true)).toBe('card')
  })

  it('shows nothing before the first state arrives, so nothing jumps into place', () => {
    expect(orgSettingsPlacement(null, false, true, false)).toBe('none')
    expect(orgSettingsPlacement({ ...base, status: 'loading' }, false, true, false)).toBe('none')
  })

  it('takes the place of the login it stands for', () => {
    type Login = { type: string; organizationSignIn?: true }
    const a: Login = { type: 'a' }
    const cloud: Login = { type: 'cloud', organizationSignIn: true }
    const b: Login = { type: 'b' }
    const all = [a, cloud, b]
    const shown = [a, b]
    expect(organizationOptionIndex(all, shown)).toBe(1)
    expect(organizationOptionIndex([cloud, a], [a])).toBe(0)
    expect(organizationOptionIndex([a, b], [a, b])).toBe(0)
  })

  it('lists capabilities the way the reader speaks', () => {
    expect(joinLabels(['Models', 'Internal systems', 'Mail'], 'en')).toBe('Models, Internal systems, and Mail')
    expect(joinLabels(['模型', '内网系统', '邮件'], 'zh-CN')).toBe('模型、内网系统和邮件')
  })
})
