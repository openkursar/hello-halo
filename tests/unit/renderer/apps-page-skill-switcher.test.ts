import { beforeEach, expect, it, vi } from 'vitest'
import type { SkillGroup } from '../../../src/shared/types/skills'

const env = vi.hoisted(() => ({
  index: 0,
  values: [] as any[],
  page: {} as any,
  apps: [] as any[],
  clearSelection: vi.fn(),
  selectApp: vi.fn(),
}))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = env.index++
    if (!(index in env.values)) env.values[index] = typeof initial === 'function' ? initial() : initial
    return [env.values[index], (value: any) => {
      env.values[index] = typeof value === 'function' ? value(env.values[index]) : value
    }]
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}))
vi.mock('../../../src/renderer/stores/apps-page.store', () => ({
  useAppsPageStore: Object.assign((select?: any) => select ? select(env.page) : env.page, { getState: () => env.page }),
  tabForAppType: (type: string) => type === 'skill' ? 'my-skills' : type === 'mcp' ? 'my-mcp' : 'my-digital-humans',
}))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: () => ({ apps: env.apps, loadApps: vi.fn(), updateAppOverrides: vi.fn() }) }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (select: any) => select({ haloSpace: null, spaces: [] }) }))
vi.mock('../../../src/renderer/stores/team.store', () => ({ useTeamStore: (select: any) => select({ currentTeamId: null, teams: [] }) }))
vi.mock('../../../src/renderer/stores/search.store', () => ({ useSearchStore: () => ({ openSearch: vi.fn() }) }))
vi.mock('../../../src/renderer/stores/people-view.store', () => ({ usePeopleViewStore: vi.fn() }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }), getCurrentLanguage: () => 'en' }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/services/home-telemetry', () => ({ trackHome: vi.fn(), takeEntry: vi.fn() }))
vi.mock('../../../src/renderer/components/layout/Header', () => ({ Header: () => null }))
vi.mock('../../../src/renderer/components/search/SearchIcon', () => ({ SearchIcon: () => null }))
vi.mock('../../../src/renderer/components/apps/LegacySkillsDialog', () => ({ LegacySkillsDialog: () => null }))
vi.mock('../../../src/renderer/components/apps/PeopleInbox', () => ({ PeopleInbox: () => null }))
vi.mock('../../../src/renderer/components/apps/PeopleDirectory', () => ({ PeopleDirectory: () => null }))
vi.mock('../../../src/renderer/components/apps/PeopleSwitcher', () => ({ PeopleSwitcher: () => null }))
vi.mock('../../../src/renderer/components/apps/CapabilitySwitcher', () => ({ CapabilitySwitcher: () => null }))
vi.mock('../../../src/renderer/components/apps/SkillDetailSwitcher', () => ({ SkillDetailSwitcher: () => null }))
vi.mock('../../../src/renderer/components/apps/PersonTeams', () => ({ PersonTeams: () => null }))
vi.mock('../../../src/renderer/components/apps/SkillCardWall', () => ({ SkillCardWall: () => null }))
vi.mock('../../../src/renderer/components/apps/McpCardWall', () => ({ McpCardWall: () => null }))
vi.mock('../../../src/renderer/components/apps/AutomationHeader', () => ({ AutomationHeader: () => null }))
vi.mock('../../../src/renderer/components/apps/AppBotSessionsView', () => ({ AppBotSessionsView: () => null }))
vi.mock('../../../src/renderer/components/apps/AppSessionsView', () => ({ AppSessionsView: () => null }))
vi.mock('../../../src/renderer/components/apps/LoginNoticeBar', () => ({ LoginNoticeBar: () => null }))
vi.mock('../../../src/renderer/components/apps/ActivityThread', () => ({ ActivityThread: () => null }))
vi.mock('../../../src/renderer/components/apps/SessionDetailView', () => ({ SessionDetailView: () => null }))
vi.mock('../../../src/renderer/components/apps/AppConfigPanel', () => ({ AppConfigPanel: () => null }))
vi.mock('../../../src/renderer/components/apps/McpStatusCard', () => ({ McpStatusCard: () => null }))
vi.mock('../../../src/renderer/components/apps/SkillInfoCard', () => ({ SkillInfoCard: () => null }))
vi.mock('../../../src/renderer/components/apps/EmptyState', () => ({ EmptyState: () => null }))
vi.mock('../../../src/renderer/components/apps/AppInstallDialog', () => ({ AppInstallDialog: () => null }))
vi.mock('../../../src/renderer/components/apps/ManualAddDialog', () => ({ ManualAddDialog: () => null }))
vi.mock('../../../src/renderer/components/apps/SkillInstallDialog', () => ({ SkillInstallDialog: () => null }))
vi.mock('../../../src/renderer/components/apps/UninstalledDetailView', () => ({ UninstalledDetailView: () => null }))
vi.mock('../../../src/renderer/components/team', () => ({ TeamTabContent: () => null }))
import { AppsPage } from '../../../src/renderer/pages/AppsPage'
import { SkillCardWall } from '../../../src/renderer/components/apps/SkillCardWall'
import { SkillDetailSwitcher } from '../../../src/renderer/components/apps/SkillDetailSwitcher'
import { SkillInfoCard } from '../../../src/renderer/components/apps/SkillInfoCard'
import { CapabilitySwitcher } from '../../../src/renderer/components/apps/CapabilitySwitcher'
import { McpStatusCard } from '../../../src/renderer/components/apps/McpStatusCard'

function render() {
  env.index = 0
  return AppsPage()
}
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  return Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
}
function find(tree: any, type: unknown) {
  const node = nodes(tree).find(node => node.type === type)
  expect(node).toBeDefined()
  return node
}
function group(name: string): SkillGroup {
  return {
    name, displayName: name, description: name, source: 'mine', conflict: false, effectiveId: `${name}-effective`,
    copies: ['shadow', 'effective'].map(suffix => ({
      id: `${name}-${suffix}`, name, displayName: name, description: name, path: `/private/${name}/${suffix}/SKILL.md`,
      scope: 'global', spaceId: null, source: 'personal', owners: [], enabled: true, availability: 'available',
      revision: 'rev', editable: true, isLink: false,
    })),
  }
}
function browseTabs(tree: any) {
  return nodes(tree).filter(node => ['My Digital Humans', 'Teams', 'Capability library'].includes(node.props.label))
}

beforeEach(() => {
  vi.clearAllMocks()
  env.values = []
  env.apps = []
  env.clearSelection.mockImplementation(() => { env.page.selectedAppId = null; env.page.detailView = null })
  env.page = {
    currentTab: 'my-skills', selectedAppId: null, detailView: null, initialAppId: null, showInstallDialog: false,
    setCurrentTab: vi.fn(), selectApp: env.selectApp, clearSelection: env.clearSelection,
    openActivityThread: vi.fn(), setInitialAppId: vi.fn(), setShowInstallDialog: vi.fn(),
    openMarketplaceFilteredBy: vi.fn(), checkUpdates: vi.fn(),
  }
})

it('opens scoped skill details with desktop-only sibling navigation and no browse tabs', () => {
  const first = group('first')
  expect(browseTabs(render())).toHaveLength(3)
  find(render(), SkillCardWall).props.onOpen(first, 'workspace-a')
  const tree = render()
  expect(env.clearSelection).toHaveBeenCalledOnce()
  expect(browseTabs(tree)).toHaveLength(0)
  const switcher = find(tree, SkillDetailSwitcher)
  expect(switcher.props).toMatchObject({ spaceId: 'workspace-a', selectedGroup: first, revision: 0 })
  const sidebar = nodes(tree).find(node => node.props.children === switcher)
  expect(sidebar.props.className).toBe('hidden md:flex')
  const detail = find(tree, SkillInfoCard)
  expect(detail.props.skillRef).toEqual({ spaceId: 'workspace-a', id: 'first-effective' })
  expect(nodes(tree).some(node => node.props.className === 'flex min-h-0 min-w-0 flex-1 flex-col' && nodes(node).includes(detail))).toBe(true)
})

it('switches siblings without returning to the wall and resets detail component identity', () => {
  const first = group('first')
  const second = group('second')
  find(render(), SkillCardWall).props.onOpen(first, null)
  const firstDetail = find(render(), SkillInfoCard)
  find(render(), SkillDetailSwitcher).props.onSelect(second)
  const tree = render()
  const nextDetail = find(tree, SkillInfoCard)
  expect(nodes(tree).some(node => node.type === SkillCardWall)).toBe(false)
  expect(nextDetail.key).not.toBe(firstDetail.key)
  expect(nextDetail.props).toMatchObject({ group: second, skillRef: { spaceId: null, id: 'second-effective' } })
  expect(find(tree, SkillDetailSwitcher).props.selectedGroup).toBe(second)
  nextDetail.props.onChanged()
  expect(find(render(), SkillDetailSwitcher).props.revision).toBe(1)
  expect(find(render(), SkillInfoCard).key).toBe(nextDetail.key)
  expect(env.selectApp).not.toHaveBeenCalled()
  const back = nodes(render()).find(node => node.type === 'button' && nodes(node).some(child => child.props.children?.includes?.('Back to capability library')))
  expect(back).toBeDefined()
  back.props.onClick()
  expect(find(render(), SkillCardWall)).toBeDefined()
  expect(browseTabs(render())).toHaveLength(3)
})

it('returns to the library after deletion and retains the old app routes for skills and MCP', () => {
  find(render(), SkillCardWall).props.onOpen(group('first'), null)
  find(render(), SkillInfoCard).props.onDeleted()
  expect(find(render(), SkillCardWall).key).toBe('1')
  for (const type of ['skill', 'mcp']) {
    env.page.currentTab = type === 'skill' ? 'my-skills' : 'my-mcp'
    env.page.selectedAppId = `legacy-${type}`
    env.page.detailView = { type: type === 'skill' ? 'skill-info' : 'mcp-status', appId: `legacy-${type}` }
    env.apps = [{ id: `legacy-${type}`, spec: { type, name: `Legacy ${type}` }, status: 'active', spaceId: null }]
    const tree = render()
    const switcher = find(tree, CapabilitySwitcher)
    expect(switcher.props).toMatchObject({ type, selectedAppId: `legacy-${type}` })
    switcher.props.onSelect('other')
    expect(env.selectApp).toHaveBeenLastCalledWith('other', type)
    expect(find(tree, type === 'skill' ? SkillInfoCard : McpStatusCard).props.appId).toBe(`legacy-${type}`)
    expect(browseTabs(tree)).toHaveLength(0)
  }
})
