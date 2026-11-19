/**
 * The broker is the only path for text the model must not hold, so the rules
 * that keep that text from reaching anywhere else are the ones under test:
 * it is handed over exactly once, every ending resolves the waiting tool call
 * rather than rejecting it, and a prompt whose page or conversation is gone is
 * abandoned instead of sitting out its timeout.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

const requested: Array<Record<string, unknown>> = []
const resolved: Array<{ requestId: string; outcome: string }> = []
vi.mock('../../../../src/main/services/ai-browser/events', () => ({
  emitBrowserCredentialRequest: (e: Record<string, unknown>) => { requested.push(e) },
  emitBrowserCredentialResolved: (e: { requestId: string; outcome: string }) => { resolved.push(e) },
}))

const {
  requestCredential,
  submitCredential,
  declineCredential,
  abandonCredentialRequestsForView,
  abandonCredentialRequestsForConversation,
  listPendingCredentialRequests,
  CREDENTIAL_WAIT_MS,
} = await import('../../../../src/main/services/ai-browser/credential-broker')

const ask = (overrides: Partial<Parameters<typeof requestCredential>[0]> = {}) =>
  requestCredential({
    conversationId: 'conv-1',
    spaceId: 'space-1',
    viewId: 'v1',
    origin: 'https://login.test',
    title: 'Sign in',
    fields: [{ uid: 'snap_1_2', label: 'Verification code' }],
    purpose: 'the page is asking for a code from your authenticator',
    ...overrides,
  })

describe('credential broker', () => {
  beforeEach(() => {
    requested.length = 0
    resolved.length = 0
  })

  afterEach(() => {
    for (const entry of listPendingCredentialRequests()) declineCredential(entry.requestId)
    vi.useRealTimers()
  })

  it('asks the user without putting the value anywhere a client could read it back', async () => {
    const pending = ask()
    expect(requested).toHaveLength(1)
    const { requestId } = requested[0] as { requestId: string }
    expect(JSON.stringify(requested[0])).not.toContain('123456')

    expect(submitCredential(requestId, { snap_1_2: '123456' })).toEqual({ accepted: true })
    await expect(pending).resolves.toMatchObject({ status: 'provided' })
    expect(resolved).toEqual([{ requestId, outcome: 'provided' }])
    // The listing a late-joining client reads never carries what was typed.
    expect(JSON.stringify(listPendingCredentialRequests())).not.toContain('123456')
  })

  it('accepts an answer once, so a replay has nothing left to fill', async () => {
    const pending = ask()
    const { requestId } = requested[0] as { requestId: string }

    submitCredential(requestId, { snap_1_2: '123456' })
    await pending

    expect(submitCredential(requestId, { snap_1_2: '000000' }).accepted).toBe(false)
    expect(declineCredential(requestId).accepted).toBe(false)
  })

  it('refuses a partial answer rather than filling some fields and submitting', async () => {
    const pending = ask({ fields: [{ uid: 'a', label: 'PIN' }, { uid: 'b', label: 'Token' }] })
    const { requestId } = requested[0] as { requestId: string }

    expect(submitCredential(requestId, { a: '1234' })).toMatchObject({ accepted: false })
    expect(submitCredential(requestId, { a: '1234', b: '' })).toMatchObject({ accepted: false })
    // Still answerable: a rejected attempt must not consume the request.
    expect(submitCredential(requestId, { a: '1234', b: '999' }).accepted).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'provided' })
  })

  it('resolves rather than throws when the user says no', async () => {
    const pending = ask()
    const { requestId } = requested[0] as { requestId: string }

    expect(declineCredential(requestId).accepted).toBe(true)
    await expect(pending).resolves.toEqual({ status: 'declined' })
  })

  it('gives up on its own so an unanswered prompt cannot wait forever', async () => {
    vi.useFakeTimers()
    const pending = ask()
    vi.advanceTimersByTime(CREDENTIAL_WAIT_MS)
    await expect(pending).resolves.toEqual({ status: 'expired' })
    expect(resolved).toEqual([{ requestId: (requested[0] as { requestId: string }).requestId, outcome: 'expired' }])
  })

  it('abandons a prompt whose page is gone, leaving other pages asking', async () => {
    const mine = ask({ viewId: 'v1' })
    const other = ask({ viewId: 'v2' })

    abandonCredentialRequestsForView('v1')

    await expect(mine).resolves.toEqual({ status: 'expired' })
    expect(listPendingCredentialRequests().map(r => r.viewId)).toEqual(['v2'])
    declineCredential((requested[1] as { requestId: string }).requestId)
    await other
  })

  it('abandons a prompt whose conversation ended, since nothing is left to fill the page', async () => {
    const mine = ask({ conversationId: 'conv-1' })
    const other = ask({ conversationId: 'conv-2' })

    // A context with no conversation must not sweep every other prompt away.
    abandonCredentialRequestsForConversation(null)
    expect(listPendingCredentialRequests()).toHaveLength(2)

    abandonCredentialRequestsForConversation('conv-1')
    await expect(mine).resolves.toEqual({ status: 'expired' })
    expect(listPendingCredentialRequests().map(r => r.conversationId)).toEqual(['conv-2'])
    declineCredential((requested[1] as { requestId: string }).requestId)
    await other
  })
})
