import { beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  index: 0,
  values: [] as any[],
  page: {} as any,
  capabilities: null as any,
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
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}))
vi.mock('../../../src/renderer/stores/apps-page.store', () => ({
  useAppsPageStore: Object.assign((select?: any) => select ? select(env.page) : env.page, { getState: () => env.page }),
}))
vi.mock('../../../src/renderer/hooks/useStoreCapabilities', () => ({ useStoreCapabilities: () => env.capabilities }))
vi.mock('../../../src/renderer/hooks/useStoreRevalidation', () => ({ useStoreRevalidation: vi.fn() }))
vi.mock('../../../src/renderer/services/home-telemetry', () => ({ currentShell: vi.fn(), takeEntry: vi.fn() }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/api', () => ({ api: { trackEvent: vi.fn() } }))
vi.mock('../../../src/renderer/components/store/ShareToStoreDialog', () => ({ ShareToStoreDialog: () => null }))
vi.mock('../../../src/renderer/components/store/StoreCategoryBar', () => ({ StoreCategoryBar: () => null }))
vi.mock('../../../src/renderer/components/store/StoreGrid', () => ({ StoreGrid: () => null }))
vi.mock('../../../src/renderer/components/store/StoreDiscover', () => ({ StoreDiscover: () => null }))
vi.mock('../../../src/renderer/components/store/StoreDetail', () => ({ StoreDetail: () => null }))
vi.mock('../../../src/renderer/components/store/StoreMine', () => ({ StoreMine: () => null }))
vi.mock('../../../src/renderer/components/store/StoreCliTools', () => ({ StoreCliTools: () => null }))
vi.mock('../../../src/renderer/components/store/StoreSkeletonGrid', () => ({ StoreSkeletonGrid: () => null }))
import { StoreHeader } from '../../../src/renderer/components/store/StoreHeader'
import { StoreView } from '../../../src/renderer/components/store/StoreView'
import { StoreCategoryBar } from '../../../src/renderer/components/store/StoreCategoryBar'
import { StoreCliTools } from '../../../src/renderer/components/store/StoreCliTools'

function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  return Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
}
function text(node: any): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(text).join('')
  return node && typeof node === 'object' ? text(node.props?.children) : ''
}
function renderHeader(props = {}) {
  env.index = 0
  const tree = StoreHeader(props)
  // Tab buttons are function components; expand them to their rendered button.
  return nodes(tree).map(node => typeof node.type === 'function' && node.type.name === 'TabButton' ? node.type(node.props) : node)
}
function tab(tree: any[], label: string) {
  return tree.find(node => node?.type === 'button' && text(node) === label && /border-b-2/.test(node.props.className))
}

beforeEach(() => {
  env.values = []
  env.capabilities = { cliTools: true, publish: true, identity: 'account' }
  env.page = {
    storeSearchQuery: '',
    storeTypeFilter: null,
    storeCategory: null,
    storeLoading: false,
    storeCliOpen: false,
    storeMineOpen: false,
    storeSelectedSlug: null,
    storeError: null,
    storeApps: [],
    storePublishIntent: null,
    setStoreSearch: vi.fn(value => { env.page.storeSearchQuery = value }),
    setStoreCategory: vi.fn(),
    setStoreTypeFilter: vi.fn(),
    setStoreCliOpen: vi.fn(open => { env.page.storeCliOpen = open }),
    setStoreMineOpen: vi.fn(),
    loadStoreApps: vi.fn(),
    revalidateStore: vi.fn(),
    refreshStore: vi.fn(),
    checkUpdates: vi.fn(),
    consumeStorePublishIntent: vi.fn(),
  }
})

it('offers command-line tools as a tab in the type row only when the store supports them', () => {
  const labels = renderHeader().filter(node => node?.type === 'button' && /border-b-2/.test(node.props.className)).map(text)
  expect(labels).toEqual(['Discover', 'Digital Human', 'Skill', 'MCP', 'CLI tools'])

  env.capabilities = { cliTools: false, publish: true, identity: 'account' }
  expect(tab(renderHeader(), 'CLI tools')).toBeUndefined()
  expect(renderHeader().some(node => node?.type?.name === 'PublishButton')).toBe(true)
})

it('selects the CLI tab, then returns to a type tab with a fresh listing', () => {
  tab(renderHeader(), 'CLI tools').props.onClick()
  expect(env.page.setStoreCliOpen).toHaveBeenCalledWith(true)
  expect(env.page.setStoreSearch).toHaveBeenCalledWith('')

  const tree = renderHeader()
  expect(tab(tree, 'CLI tools').props.className).toContain('border-primary')
  expect(tab(tree, 'Discover').props.className).not.toContain('border-primary')
  expect(tree.find(node => node?.type === 'input').props.placeholder).toBe('Search command-line tools')

  // Discover is already the type filter, but leaving the CLI tab must still switch views.
  tab(tree, 'Discover').props.onClick()
  expect(env.page.setStoreCliOpen).toHaveBeenLastCalledWith(false)
  expect(env.page.loadStoreApps).toHaveBeenCalledWith({ type: undefined })
})

it('searching on the CLI tab does not query the app store', () => {
  vi.useFakeTimers()
  env.page.storeCliOpen = true
  renderHeader().find(node => node?.type === 'input').props.onChange({ target: { value: 'pret' } })
  vi.runAllTimers()
  vi.useRealTimers()
  expect(env.page.setStoreSearch).toHaveBeenCalledWith('pret')
  expect(env.page.loadStoreApps).not.toHaveBeenCalled()
})

it('renders the CLI list under the store header without the category bar', () => {
  env.page.storeCliOpen = true
  env.index = 0
  const tree = nodes(StoreView())
  const header = tree.find(node => node.type === StoreHeader)
  expect(header).toBeDefined()
  expect(tree.some(node => node.type === StoreCliTools)).toBe(true)
  expect(tree.some(node => node.type === StoreCategoryBar)).toBe(false)

  // The header's refresh reloads the CLI catalog rather than the app index.
  header.props.onRefresh()
  env.index = 0
  const reloaded = nodes(StoreView()).find(node => node.type === StoreCliTools)
  expect(reloaded.props.reloadKey).toBe(1)
})
