/**
 * When the invite dialog saves its answer (read-only by default) for a team's
 * first link: once the call that may create the link returns.
 *
 *   - opening the dialog saves nothing by itself;
 *   - an answer saying no link was created (Remote Access off, no federation)
 *     saves nothing, and leaves the save to a later try that creates one;
 *   - any other outcome saves, failures and a call that threw included: a link
 *     issued whose reply was lost would otherwise be out with every member
 *     unset, which lends a colleague everything;
 *   - it saves once, however many links follow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The server renderer runs no effects; collect the dialog's to run them as mounting would.
const effects: Array<() => unknown> = []
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useEffect: (effect: () => unknown) => { effects.push(effect) } }
})
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: unknown) => node,
}))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))

const generateInvite = vi.fn()
vi.mock('../../../src/renderer/api', () => ({
  api: { teamGenerateInvite: (teamId: string) => generateInvite(teamId), teamRevokeInvite: vi.fn() },
}))

const TEAM = 'team-1'
const updateMember = vi.fn(async () => true)
const members = [
  { appId: 'lead', origin: 'local' },
  { appId: 'writer', origin: 'local' },
  { appId: 'guest-machine', origin: 'remote', ownerNodeId: 'other-node' },
]
let crossesMachines = false
vi.mock('../../../src/renderer/stores/team.store', () => {
  const getState = () => ({ updateMember, detail: { team: { id: TEAM }, members, crossesMachines } })
  return {
    useTeamStore: Object.assign((select: (s: ReturnType<typeof getState>) => unknown) => select(getState()), { getState }),
    detailOf: (s: ReturnType<typeof getState>, teamId: string) => (s.detail.team.id === teamId ? s.detail : null),
  }
})
vi.mock('../../../src/renderer/stores/apps.store', () => ({
  useAppsStore: Object.assign(() => null, { getState: () => ({ apps: [] }) }),
}))
vi.mock('../../../src/renderer/components/capability/DelegationPresetPicker', () => ({ DelegationPresetPicker: () => null }))
vi.mock('../../../src/renderer/components/team/lendable-items', () => ({ inventoryOf: vi.fn(), loadLendableItems: vi.fn() }))

const { firstInviteSaver, inviteMayExist } = await import('../../../src/renderer/components/team/first-invite')
const { TeamInviteDialog } = await import('../../../src/renderer/components/team/TeamInviteDialog')
const { withPreset } = await import('../../../src/renderer/components/team/delegated-policy')

type Answer = { success: boolean; error?: string; data?: unknown }

describe('which answers to the invite call may leave a link out', () => {
  it.each(['REMOTE_ACCESS_OFF', 'FEDERATION_UNAVAILABLE', 'TEAM_NOT_FOUND'])('%s: none, the call stops before issuing', (error) => {
    expect(inviteMayExist({ success: false, error })).toBe(false)
  })

  it.each([
    ['a link', { success: true }],
    ['a failure after the call started', { success: false, error: 'database is locked' }],
    ['a failure without a code', { success: false }],
    ['no answer at all', null],
  ])('%s: maybe', (_label, answer) => {
    expect(inviteMayExist(answer)).toBe(true)
  })

  it('saves after a later try that may have made one, and never twice', () => {
    const save = vi.fn()
    const settle = firstInviteSaver(save)

    settle({ success: false, error: 'REMOTE_ACCESS_OFF' })
    expect(save).not.toHaveBeenCalled()
    settle({ success: true })
    settle(null)
    settle({ success: true })

    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe('the invite dialog on a team that does not reach another computer yet', () => {
  const link = { success: true, data: { url: 'http://host/?office=team-1&invite=tok', jti: 'jti-1' } }
  const readOnly = withPreset(undefined, 'read_only')
  let answer: (value: Answer) => void
  let fail: (error: Error) => void

  beforeEach(() => {
    effects.length = 0
    crossesMachines = false
    updateMember.mockClear()
    generateInvite.mockReset()
    generateInvite.mockImplementation(() => new Promise<Answer>((resolve, reject) => {
      answer = resolve
      fail = reject
    }))
    vi.stubGlobal('document', { body: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function open(): void {
    renderToStaticMarkup(createElement(TeamInviteDialog, { teamId: TEAM, onClose: () => {} }))
    for (const effect of effects.splice(0)) effect()
  }

  const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('saves read-only for every local member once the link is made, not as it opens', async () => {
    open()
    expect(generateInvite).toHaveBeenCalledWith(TEAM)
    expect(updateMember).not.toHaveBeenCalled()

    answer(link)
    await settled()

    expect(updateMember.mock.calls).toEqual([
      [TEAM, 'lead', { delegatedPolicy: readOnly }],
      [TEAM, 'writer', { delegatedPolicy: readOnly }],
    ])
  })

  it.each(['REMOTE_ACCESS_OFF', 'FEDERATION_UNAVAILABLE'])('saves nothing when the call answers %s', async (error) => {
    open()
    answer({ success: false, error })
    await settled()

    expect(updateMember).not.toHaveBeenCalled()
  })

  it('saves when the call fails without saying nothing was made', async () => {
    open()
    fail(new Error('reply lost'))
    await settled()

    expect(updateMember).toHaveBeenCalledTimes(2)
  })

  it('leaves a team that already reaches another computer as it is saved', async () => {
    crossesMachines = true
    open()
    answer(link)
    await settled()

    expect(updateMember).not.toHaveBeenCalled()
  })
})
