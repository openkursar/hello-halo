/**
 * Leaving a team hosted on someone else's computer, and taking one digital
 * human out of it, as the settings screen presents them.
 *
 *   - Each of this computer's digital humans in a joined team has its own
 *     "Remove from team"; a teammate's digital human has none, and a team this
 *     computer hosts keeps its own "Remove member" for the people who run it.
 *   - Leaving says, by name and number, which digital humans go with it, and is
 *     marked destructive when it takes more than one: one press takes them all.
 *   - Taking one out says the others stay and that its duty is kept.
 *   - The roster can change under an open dialog. The dialog speaks of the
 *     members as they are now, closes once its member is gone, and its press
 *     only ever asks to take out that one member (the main process decides,
 *     when it runs, whether that is leaving).
 *
 * The dialog's open state is injected through a useState wrapper: the server
 * renderer cannot click. Null-initialised useState calls in a joined team's
 * settings render are, in order: promote, remove, withdraw (MembersSection).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const h = vi.hoisted(() => ({
  queue: [] as unknown[],
  dialogs: [] as Array<Record<string, unknown>>,
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const useState = (init: unknown) => {
    const pair = actual.useState(init as never)
    if (init === null && h.queue.length > 0) return [h.queue.shift(), pair[1]]
    return pair
  }
  return { ...actual, default: { ...actual, useState }, useState }
})

const interpolate = (text: string, options?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(options?.[key] ?? ''))

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: interpolate }) }))
vi.mock('../../../src/renderer/stores/team.store', () => {
  h.store = {
    addMember: vi.fn(), removeMember: vi.fn(), updateTeam: vi.fn(), dissolveTeam: vi.fn(),
    leaveOffice: vi.fn(), withdrawMember: vi.fn(),
  }
  const state = { teams: [], ...h.store }
  return { useTeamStore: (select: (s: typeof state) => unknown) => select(state) }
})
vi.mock('../../../src/renderer/stores/team-view-prefs.store', () => ({
  useOfficeSkin: () => 'cartoon',
  useTeamViewPrefsStore: (select: (s: unknown) => unknown) => select({ setOfficeSkin: () => {} }),
}))
vi.mock('../../../src/renderer/stores/apps.store', () => ({
  useAppsStore: (select: (s: unknown) => unknown) => select({ apps: [] }),
}))
vi.mock('../../../src/renderer/hooks/useAutosaveDraft', () => ({
  useAutosaveDraft: (value: string) => [value, () => {}, () => {}],
}))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/components/apps/SchedulePicker', () => ({ SchedulePicker: () => null }))
vi.mock('../../../src/renderer/components/apps/SystemPromptEditor', () => ({ SystemPromptEditor: () => null }))
vi.mock('../../../src/renderer/components/apps/AppInstallDialog', () => ({ AppInstallDialog: () => null }))
vi.mock('../../../src/renderer/components/common/HttpTriggerCard', () => ({ HttpTriggerCard: () => null }))
vi.mock('../../../src/renderer/components/capability/DelegationPresetPicker', () => ({ DelegationPresetPicker: () => null }))
vi.mock('../../../src/renderer/components/team/TeamMemberSettings', () => ({ TeamMemberSettings: () => null }))
vi.mock('../../../src/renderer/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: (props: Record<string, unknown>) => { h.dialogs.push(props); return null },
}))
vi.mock('../../../src/renderer/components/ui/Switch', () => ({ Switch: () => null }))
vi.mock('../../../src/renderer/components/ui/Disclosure', () => ({
  Disclosure: ({ children }: { children: unknown }) => children,
}))

const { leaveTeamConfirm, leaveTeamHint, withdrawMemberConfirm } = await import('../../../src/renderer/components/team/leave-team')
const { SettingsTab } = await import('../../../src/renderer/components/team/SettingsTab')

const t = interpolate

beforeEach(() => {
  h.queue = []
  h.dialogs = []
  for (const fn of Object.values(h.store)) fn.mockClear()
})

describe('the confirmation for leaving a joined team', () => {
  it('names every digital human that leaves, and how many, as a destructive action', () => {
    const copy = leaveTeamConfirm('Release', ['Writer', 'Tester', 'Reviewer'], t)

    expect(copy.title).toContain('Release')
    expect(copy.message).toContain('All 3 of your digital humans')
    expect(copy.message).toContain('Writer, Tester, Reviewer')
    expect(copy.confirmLabel).toContain('3')
    expect(copy.variant).toBe('danger')
  })

  it('names a single digital human on its own, without the destructive colour', () => {
    const copy = leaveTeamConfirm('Release', ['Writer'], t)

    expect(copy.message).toContain('Writer')
    expect(copy.message).not.toContain('All 1')
    expect(copy.variant).toBe('default')
  })

  it('says each duty is kept for a rejoin', () => {
    expect(leaveTeamConfirm('Release', ['Writer', 'Tester'], t).message).toMatch(/duty/)
    expect(leaveTeamConfirm('Release', ['Writer'], t).message).toMatch(/duty/)
  })

  it('says under the button how many leave, and where to take out just one', () => {
    expect(leaveTeamHint(7, t)).toContain('7')
    expect(leaveTeamHint(7, t)).toMatch(/just one/)
  })
})

describe('the confirmation for taking one digital human out', () => {
  it('names it, says the others stay and its duty is kept', () => {
    const copy = withdrawMemberConfirm('Release', 'Tester', t)

    expect(copy.title).toContain('Tester')
    expect(copy.title).toContain('Release')
    expect(copy.message).toMatch(/other digital humans/)
    expect(copy.message).toMatch(/duty/)
  })
})

const member = (appId: string, extra: Record<string, unknown> = {}) => ({
  teamId: 'team', appId, memberName: appId, role: '', isLead: false, aiProvisioned: false, addedAt: 1,
  ownerNodeId: 'SELF', origin: 'local', duty: null, ...extra,
})

const hostLead = member('host-lead', { isLead: true, origin: 'remote', ownerNodeId: 'node-host' })

function render(hostNodeId: string | null, members: ReturnType<typeof member>[]): string {
  const detail = {
    team: { id: 'team', name: 'Release', goal: 'Ship', owningSpaceId: 'space', collabMode: 'free', escalationRouting: 'lead', hostNodeId },
    members,
    roster: [],
    pendingEscalations: [],
  } as never
  return renderToStaticMarkup(createElement(SettingsTab, { detail, openMemberId: null, onOpenMemberChange: () => {} }))
}

/** A joined team's settings with the "Remove from team" dialog open for `target`. */
function renderWithdrawDialog(members: ReturnType<typeof member>[], target: string) {
  h.queue = [null, null, { appId: target, name: target }] // promote, remove, withdraw
  render('node-host', members)
  h.queue = []
  return h.dialogs
}

const count = (html: string, needle: string) => html.split(needle).length - 1

describe('the member list of a joined team', () => {
  const joined = () => render('node-host', [
    hostLead,
    member('my-writer'),
    member('my-tester'),
    member('their-analyst', { origin: 'remote', ownerNodeId: 'node-teammate' }),
  ])

  it('offers "Remove from team" on each of this computer’s digital humans, and on no one else’s', () => {
    const html = joined()

    expect(count(html, 'title="Remove from team"')).toBe(2)
    expect(html).not.toContain('title="Remove member"')
  })

  it('says under Leave that all of this computer’s digital humans go with it', () => {
    expect(joined()).toContain('Takes all 2 of your digital humans out of this team')
  })
})

describe('the "Remove from team" dialog', () => {
  it('takes out only its member while others stay', () => {
    const dialogs = renderWithdrawDialog([hostLead, member('my-writer'), member('my-tester')], 'my-writer')

    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].title).toBe('Remove my-writer from Release?')
    expect(dialogs[0].variant).toBe('default')
    ;(dialogs[0].onConfirm as () => void)()
    expect(h.store.withdrawMember).toHaveBeenCalledWith('team', 'my-writer')
    expect(h.store.leaveOffice).not.toHaveBeenCalled()
  })

  it('says it is leaving when its member is the last one here, and still asks only for that member', () => {
    const dialogs = renderWithdrawDialog([hostLead, member('my-writer')], 'my-writer')

    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].title).toBe('Leave Release?')
    expect(dialogs[0].message).toContain('my-writer leaves this team with you')
    ;(dialogs[0].onConfirm as () => void)()
    expect(h.store.withdrawMember).toHaveBeenCalledWith('team', 'my-writer')
    expect(h.store.leaveOffice).not.toHaveBeenCalled()
  })

  it('closes when its member left while it was open, instead of offering to take out the rest', () => {
    const dialogs = renderWithdrawDialog([hostLead, member('my-tester')], 'my-writer')

    expect(dialogs).toEqual([])
    expect(h.store.withdrawMember).not.toHaveBeenCalled()
    expect(h.store.leaveOffice).not.toHaveBeenCalled()
  })
})

describe('the member list of a team this computer hosts', () => {
  it('keeps "Remove member" for everyone but the lead', () => {
    const html = render(null, [member('lead', { isLead: true }), member('writer'), member('tester')])

    expect(count(html, 'title="Remove member"')).toBe(2)
    expect(html).not.toContain('title="Remove from team"')
  })
})
