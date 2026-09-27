import { beforeEach, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({ runner: null as any, people: {} as any, apps: {} as any, directory: {} as any, teams: [] as any[], page: {} as any, api: {} as any }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (value: any) => env.runner.state(value), useRef: (value: any) => env.runner.ref(value), useMemo: (compute: any) => compute(), useCallback: (fn: any) => fn, useEffect: () => {}, useLayoutEffect: () => {} }))
vi.mock('zustand/react/shallow', () => ({ useShallow: (select: any) => select }))
vi.mock('../../../src/renderer/stores/people-view.store', () => ({ usePeopleViewStore: Object.assign((select?: any) => select ? select(env.people) : env.people, { getState: () => env.people, setState: (patch: any) => Object.assign(env.people, patch) }) }))
vi.mock('../../../src/renderer/stores/people-directory.store', () => ({ usePeopleDirectoryStore: () => env.directory }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: Object.assign((select: any) => select(env.apps), { getState: () => env.apps }) }))
vi.mock('../../../src/renderer/stores/team.store', () => ({ useTeamStore: Object.assign((select: any) => select({ teams: env.teams }), { getState: () => ({}) }) }))
vi.mock('../../../src/renderer/stores/apps-page.store', () => ({ useAppsPageStore: { getState: () => env.page } }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }), getCurrentLanguage: () => 'en' }))
vi.mock('../../../src/renderer/utils/spec-i18n', () => ({ resolveSpecI18n: (spec: any) => spec }))
vi.mock('../../../src/renderer/hooks/useDataContent', () => ({ useDataContent: () => ({}) }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({ AutomationAvatar: () => null }))
// Reaches the space store, and through it the chat/canvas singletons — out of
// reach of this file's api stub and irrelevant to what the directory renders.
vi.mock('../../../src/renderer/components/apps/WorkspaceMigrationDialog', () => ({ WorkspaceMigrationDialog: () => null }))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({ openDigitalHumanChat: vi.fn() }))
import { PeopleDirectory } from '../../../src/renderer/components/apps/PeopleDirectory'
import { EscalationCard } from '../../../src/renderer/components/apps/EscalationCard'

class ComponentRunner {
  values: any[] = []; index = 0
  state(initial: any) { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial; return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }] }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  render(component: () => any) { this.index = 0; env.runner = this; return component() }
}
/** Flattens the element tree, rendering plain function components inline so
 * assertions see through extracted sub-components like PersonCard. */
function nodes(tree: any): any[] { if (!tree || typeof tree !== 'object') return []; if (typeof tree.type === 'function') return nodes(tree.type(tree.props)); return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }
function element(tree: any, type: string, label?: string) { return nodes(tree).find(node => node.type === type && (!label || node.props['aria-label'] === label || node.props.children === label)) }
const app = (id: string, spaceId: string) => ({ id, spaceId, status: 'active', spec: { type: 'automation', name: id, description: `${id} research` } }) as any
beforeEach(() => {
  env.people = { query: '', team: '', space: '', attention: false, view: 'cards', page: 1, directoryScroll: 80, drafts: {}, setFilters: (patch: any) => Object.assign(env.people, patch), rememberPerson: vi.fn(), saveDraft: (key: string, value: any) => { env.people.drafts[key] = value }, clearDraft: (key: string) => { delete env.people.drafts[key] } }
  env.apps = { appStates: { Lin: { pendingDecisionCount: 1 }, Amy: { pendingDecisionCount: 0 } }, activityEntries: {}, isLoading: false, error: null }
  env.directory = { data: { items: [{ id: 'Lin', name: 'Lin', description: 'Research', status: 'paused', spaceId: 'halo', state: { pendingDecisionCount: 1 }, teams: [{ id: 'research', name: 'Research' }] }], total: 1, attentionTotal: 1, removedTotal: 0 }, load: vi.fn(), refresh: vi.fn(), loading: false, error: false }
  env.teams = [{ id: 'research', name: 'Research', localMembers: [{ appId: 'Lin' }] }]
  env.page = { openActivityThread: vi.fn(), openAppTeams: vi.fn() }
})
it('directory retains search, team, workspace and attention preferences when opening a summarized person', () => {
  const runner = new ComponentRunner()
  const render = () => runner.render(() => PeopleDirectory({ spaceMap: { halo: 'Halo', other: 'Other' }, onCreate: vi.fn() }))
  let tree = render(); expect(nodes(tree).filter(node => node.type === 'article')).toHaveLength(1)
  element(tree, 'input', 'Search digital humans').props.onChange({ target: { value: 'research' } })
  element(tree, 'select', 'Filter by team').props.onChange({ target: { value: 'research' } })
  element(tree, 'select', 'Filter by workspace').props.onChange({ target: { value: 'halo' } })
  element(tree, 'button', 'Needs my attention').props.onClick()
  tree = render(); expect(nodes(tree).filter(node => node.type === 'article')).toHaveLength(1)
  element(tree, 'button', 'List view').props.onClick(); tree = render()
  const article = nodes(tree).find(node => node.type === 'article')
  nodes(article).find(node => node.type === 'button').props.onClick({ stopPropagation: () => {} })
  expect(env.page.openActivityThread).toHaveBeenCalledWith('Lin')
  expect(env.people).toMatchObject({ query: 'research', team: 'research', space: 'halo', attention: true, view: 'list', directoryScroll: 80 })
})
it('lists a stopped person as needing the owner and says so on the card', () => {
  env.directory.data.items = [{ id: 'Kai', name: 'Kai', description: 'Ops', status: 'error', spaceId: 'halo', state: { blocked: 'auto_disabled', automaticEnabled: false, pendingDecisionCount: 0 }, teams: [] }]
  const tree = new ComponentRunner().render(() => PeopleDirectory({ spaceMap: { halo: 'Halo' }, onCreate: vi.fn() }))
  const labels = nodes(tree).filter(node => node.type === 'h2').map(node => node.props.children).flat(Infinity)
  expect(labels).toContain('Needs you')
  expect(labels).not.toContain('Paused')
  // Stopping turns automatic tasks off, so the card must not read as paused.
  expect(nodes(tree).some(node => node.type === 'span' && node.props.children === 'Stopped, waiting for you')).toBe(true)
})

it('failed submission retains the exact draft after closing and reopening the question', async () => {
  const entry = { id: 'question', appId: 'Lin', runId: 'run', type: 'escalation', ts: 1, content: { summary: 'Approve?' } } as any
  env.apps.respondToEscalation = vi.fn().mockResolvedValue(false)
  let runner = new ComponentRunner()
  const render = () => runner.render(() => EscalationCard({ entry, appId: 'Lin' }))
  let tree = render()
  element(tree, 'textarea').props.onChange({ target: { value: 'Keep my exact answer' } })
  tree = render()
  const submit = nodes(tree).find(node => node.type === 'button' && node.props.className.includes('bg-primary'))
  submit.props.onClick(); await Promise.resolve(); await Promise.resolve()
  expect(env.apps.respondToEscalation).toHaveBeenCalledWith('Lin', 'question', { text: 'Keep my exact answer' })
  runner = new ComponentRunner(); tree = render()
  expect(element(tree, 'textarea').props.value).toBe('Keep my exact answer')
  expect(env.people.drafts['Lin:question']).toEqual([{ text: 'Keep my exact answer' }])
})
it('a canonical answer received in another surface disables resubmission and preserves the unsent draft', () => {
  const entry = { id: 'question', appId: 'Lin', runId: 'run', type: 'escalation', ts: 1, content: { summary: 'Approve?' } } as any
  env.people.drafts['Lin:question'] = [{ text: 'Local draft' }]
  env.apps.activityEntries.Lin = [{ ...entry, userResponse: { ts: 3, text: 'Accepted elsewhere' }, continuation: { status: 'queued', attempts: 0, updatedAt: 4 } }]
  const tree = new ComponentRunner().render(() => EscalationCard({ entry, appId: 'Lin' }))
  expect(element(tree, 'textarea')).toBeUndefined()
  expect(element(tree, 'summary', 'Your unsent draft was preserved')).toBeDefined()
  expect(env.people.drafts['Lin:question'][0].text).toBe('Local draft')
})
