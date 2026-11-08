import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistryEntry, UpdateInfo } from '../../../src/shared/store/store-types'

const env = vi.hoisted(() => ({
  runner: null as unknown as HookRunner,
  api: { storePreviewUpgrade: vi.fn(), storeApplyUpgrade: vi.fn(), trackEvent: vi.fn(), storeIgnoreVersion: vi.fn() },
  show: vi.fn(), loadApps: vi.fn(), checkUpdates: vi.fn(),
}))
class HookRunner {
  values: unknown[] = []
  index = 0
  state(initial: unknown) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = initial
    return [this.values[index], (value: unknown) => { this.values[index] = value }]
  }
  render<T>(fn: () => T): T { this.index = 0; env.runner = this; return fn() }
}
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => env.runner.state(initial),
  useMemo: (fn: () => unknown) => fn(),
}))
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({
  t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values?.[key] ?? '')),
  i18n: { language: 'en' },
}) }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: { getState: () => ({ loadApps: env.loadApps }) } }))
vi.mock('../../../src/renderer/stores/apps-page.store', () => ({ useAppsPageStore: { getState: () => ({ checkUpdates: env.checkUpdates }) } }))
vi.mock('../../../src/renderer/stores/notification.store', () => ({ useNotificationStore: { getState: () => ({ show: env.show }) } }))
vi.mock('../../../src/renderer/components/store/StoreInstallDialog', () => ({ StoreInstallDialog: () => null }))
import { useStoreUpdateFlow } from '../../../src/renderer/components/store/useStoreUpdateFlow'
import { StoreUpdateDialog } from '../../../src/renderer/components/store/StoreUpdateDialog'

type Node = { type?: unknown; props: Record<string, any> }
function nodes(tree: any): Node[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}
const text = (tree: unknown) => nodes(tree).flatMap(node => [node.props?.children].flat(Infinity)).filter(child => typeof child === 'string').join(' ')
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
function open(type = 'skill', onUpdated?: () => void) {
  const runner = new HookRunner()
  const render = () => runner.render(() => useStoreUpdateFlow(
    { slug: 'test', type } as RegistryEntry,
    { appId: 'installed', currentVersion: '1', latestVersion: '2' } as UpdateInfo,
    undefined, onUpdated,
  ))
  render().start()
  const props = () => nodes(render().dialogs).find(node => node.type === StoreUpdateDialog)!.props
  return { render, props }
}
function options(props: any) {
  const tree = StoreUpdateDialog(props)
  return { tree, rows: nodes(tree).filter(node => node.props?.option).map(node => ({
    option: node.props.option,
    button: (node.type as (props: any) => Node)(node.props),
  })) }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('document', { body: {} })
  env.api.storePreviewUpgrade.mockReset().mockResolvedValue({ success: true, data: { kept: ['skill_files'], editsKnown: true } })
  env.api.storeApplyUpgrade.mockReset().mockResolvedValue({ success: true, data: { from: '1', to: '2.1', kept: [], editsKnown: true } })
  env.api.storeIgnoreVersion.mockReset().mockResolvedValue({ success: true })
})
describe('skill store update confirmation', () => {
  it('keeps the installed package and ignores exactly the offered version through the existing workflow', async () => {
    const flow = open()
    expect(env.api.storePreviewUpgrade).toHaveBeenCalledWith('installed')
    expect(options(flow.props()).rows[1].button.props.disabled).toBe(true)
    await settle()
    const { tree, rows } = options(flow.props())
    expect(text(tree)).not.toContain('Work activity')
    expect(rows.map(row => row.option.title)).toEqual(['Keep current version', 'Replace with new version'])
    expect(rows[1].option.description).toContain('entire skill package')
    expect(rows[1].option.description).toContain('nothing is automatically merged')
    expect(rows[1].button.props.disabled).toBeFalsy()
    expect(rows[0].option.description).toContain('newer versions still notify')
    await rows[0].option.onClick()
    expect(nodes(flow.render().dialogs).some(node => node.type === StoreUpdateDialog)).toBe(false)
    expect(env.api.storeApplyUpgrade).not.toHaveBeenCalled()
    expect(env.api.storeIgnoreVersion).toHaveBeenCalledOnce()
    expect(env.api.storeIgnoreVersion).toHaveBeenCalledWith({ appId: 'installed', version: '2' })
    expect(env.checkUpdates).toHaveBeenCalledOnce()
    expect(env.loadApps).not.toHaveBeenCalled()
  })
  it('uses force only on replacement and refreshes the visible file detail after success', async () => {
    const onUpdated = vi.fn()
    const flow = open('skill', onUpdated); await settle()
    await flow.props().onOverwrite()
    expect(env.api.storeApplyUpgrade).toHaveBeenCalledWith('installed', 'force')
    expect(env.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Updated', body: 'Updated to version 2.1.' }))
    expect(env.loadApps).toHaveBeenCalled()
    expect(onUpdated).toHaveBeenCalledOnce()
  })
  it('does not announce an update when the backend kept the version', async () => {
    env.api.storeApplyUpgrade.mockResolvedValue({ success: true, data: { from: '1', to: '1', kept: ['skill_files'], editsKnown: true } })
    const flow = open(); await settle(); await flow.props().onOverwrite()
    expect(env.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Current version kept', body: 'Kept version 1.' }))
  })
  it('blocks replacement when preview fails, including direct hook callback invocation', async () => {
    env.api.storePreviewUpgrade.mockResolvedValue({ success: false, error: 'offline' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const flow = open(); await settle()
    const { tree, rows } = options(flow.props())
    expect(text(tree)).toContain('Replacement is unavailable')
    expect(rows[1].button.props.disabled).toBe(true)
    expect(rows[1].option.recommended).toBeFalsy()
    await flow.props().onOverwrite()
    expect(env.api.storeApplyUpgrade).not.toHaveBeenCalled()
    warn.mockRestore()
  })
  it('retains the automation merge choices and preview', async () => {
    const flow = open('automation'); await settle()
    const { tree, rows } = options(flow.props())
    expect(env.api.storePreviewUpgrade).toHaveBeenCalledWith('installed')
    expect(rows.map(row => row.option.title)).toEqual(['Update in place', 'Keep current, install as a new copy', 'Skip this version'])
    expect(text(tree)).toContain('Work activity')
    expect(rows[0].option.recommended).toBe(true)
  })
  it('leaves other app types without preview and with the original overwrite choices', () => {
    const flow = open('mcp')
    expect(env.api.storePreviewUpgrade).not.toHaveBeenCalled()
    expect(options(flow.props()).rows[0].option.title).toBe('Overwrite upgrade')
  })
})
