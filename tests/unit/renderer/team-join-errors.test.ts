/**
 * What the join dialog says when a join is refused. A link to the person's own
 * team, opened on the computer that hosts it, is not a failed join: it says
 * the team is already theirs, here, instead of pointing at the link or the
 * inviter's connection — and offers none of the tips for a join that failed.
 *
 * The dialog runs on a small hook runner so its own Join button can be pressed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, join: vi.fn() }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useMemo: (compute: () => unknown) => compute(),
  useEffect: () => {},
}))
vi.mock('react-dom', async original => ({
  ...await original<typeof import('react-dom')>(),
  createPortal: (node: unknown) => node,
}))
vi.mock('../../../src/renderer/api', () => ({ api: { teamJoinOffice: env.join } }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({
  useAppsStore: (select: (s: unknown) => unknown) => select({
    apps: [{ id: 'app-writer', spaceId: null, status: 'active', spec: { type: 'automation', name: 'Writer' } }],
    loadApps: async () => {},
  }),
}))
vi.mock('../../../src/renderer/stores/team.store', () => ({
  useTeamStore: (select: (s: unknown) => unknown) => select({ teams: [], loadTeams: async () => {}, updateMember: async () => true }),
}))
vi.mock('../../../src/renderer/services/request-update-check', () => ({ requestUpdateCheck: vi.fn() }))
vi.mock('../../../src/renderer/components/capability/DelegationPresetPicker', () => ({ DelegationPresetPicker: () => null }))

const { joinErrorText, TeamJoinDialog } = await import('../../../src/renderer/components/team/TeamJoinDialog')

const t = (text: string) => text

class ComponentRunner {
  values: any[] = []
  index = 0
  state(initial: any) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = initial
    return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }]
  }
  render(component: () => any) { this.index = 0; env.runner = this; return component() }
}

function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}
const texts = (tree: any) => nodes(tree).flatMap(node => [node.props?.children].flat()).filter(child => typeof child === 'string')
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && texts(node).includes(label))

const OWN_TEAM_TEXT = 'This is your own team — it’s already on this computer.'
const TIPS = 'Having trouble joining?'

/** The dialog with a digital human brought and what is shared agreed to. */
function readyToJoin() {
  const runner = new ComponentRunner()
  const render = () => runner.render(() => TeamJoinDialog({ onClose: () => {}, initialLink: 'http://host:3017/?office=team-1&invite=tok' }))
  button(render(), 'Writer').props.onClick()
  nodes(render()).find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } })
  return {
    /** Press Join; what the dialog then shows. */
    async join(): Promise<string[]> {
      await button(render(), 'Join').props.onClick()
      return texts(render())
    },
  }
}

describe('the join dialog’s refusal text', () => {
  it('says a link to this computer’s own team is the person’s own team, already here', () => {
    expect(joinErrorText('OWN_TEAM', t)).toBe(OWN_TEAM_TEXT)
  })

  it('does not fall back to the generic “check the link” text for it', () => {
    expect(joinErrorText('OWN_TEAM', t)).not.toBe(joinErrorText(undefined, t))
  })
})

describe('the join dialog after a refused join', () => {
  beforeEach(() => {
    env.join.mockReset()
    vi.stubGlobal('document', { body: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows only the refusal for the person’s own team, with no tips for a join that failed', async () => {
    env.join.mockResolvedValue({ success: false, error: 'OWN_TEAM' })

    const shown = await readyToJoin().join()

    expect(env.join).toHaveBeenCalledTimes(1)
    expect(shown).toContain(OWN_TEAM_TEXT)
    expect(shown).not.toContain(TIPS)
  })

  it('still offers the tips when the join failed', async () => {
    env.join.mockResolvedValue({ success: false, error: 'AUTH_REJECTED' })

    const shown = await readyToJoin().join()

    expect(shown).toContain('This invite is no longer valid — it may have expired, been revoked, or the team was closed. Ask for a new invite link.')
    expect(shown).toContain(TIPS)
  })

  it('offers them again when a later try fails', async () => {
    const dialog = readyToJoin()
    env.join.mockResolvedValueOnce({ success: false, error: 'OWN_TEAM' })
    expect(await dialog.join()).not.toContain(TIPS)

    env.join.mockRejectedValueOnce(new Error('connection lost'))
    const shown = await dialog.join()

    expect(shown).toContain('Could not join the team. Check the link and that the person who invited you is online.')
    expect(shown).toContain(TIPS)
  })
})
