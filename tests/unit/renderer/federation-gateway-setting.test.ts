import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

const env = vi.hoisted(() => ({ runner: null as any, api: {
  getConfig: vi.fn(), setConfig: vi.fn(), getRemoteStatus: vi.fn(), onRemoteStatusChange: vi.fn(),
} }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => env.runner.state(initial),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => env.runner.effect(effect, deps),
}))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/hooks/useSecurityPolicy', () => ({ useSecurityPolicy: () => ({ tunnelSafe: true }) }))

import { RemoteAccessSection } from '../../../src/renderer/components/settings/RemoteAccessSection'

class ComponentRunner {
  values: unknown[] = []
  effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  pending: (() => void)[] = []
  index = 0
  state(initial: unknown) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = initial
    return [this.values[index], (update: unknown) => { this.values[index] = update }]
  }
  effect(callback: () => void | (() => void), deps: unknown[]) {
    const index = this.index++
    const previous = this.effects.get(index)
    if (previous && deps.every((dep, i) => dep === previous.deps[i])) return
    this.pending.push(() => {
      previous?.cleanup?.()
      const cleanup = callback()
      this.effects.set(index, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
    })
  }
  render(component: () => ReactElement) {
    this.index = 0
    env.runner = this
    const tree = component()
    this.pending.splice(0).forEach(effect => effect())
    return tree
  }
  unmount() { for (const effect of this.effects.values()) effect.cleanup?.() }
}

type Node = { type?: unknown; props?: Record<string, any> }
function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}
function text(tree: unknown): string {
  if (typeof tree === 'string') return tree
  if (!tree || typeof tree !== 'object') return ''
  return [(tree as Node).props?.children].flat(Infinity).map(text).join(' ')
}
const input = (tree: unknown) => nodes(tree).find(node => node.type === 'input' && node.props?.['aria-label'] === 'Federation Gateway')!
const save = (tree: unknown) => nodes(tree).find(node => node.type === 'button' && text(node).trim() === 'Save')!
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const productUrl = 'https://relay.example.test/'
const metadata = (gatewayUrl: string | null) => ({ success: true, productDefaults: { federation: { gatewayUrl } } })
let runner: ComponentRunner
let setConfig: ReturnType<typeof vi.fn>
function render(gatewayUrl = '') {
  return runner.render(() => RemoteAccessSection({ config: { federation: { gatewayUrl } } as never, setConfig }))
}

beforeEach(() => {
  vi.useFakeTimers()
  runner = new ComponentRunner()
  setConfig = vi.fn()
  env.api.getConfig.mockReset().mockResolvedValue(metadata(productUrl))
  env.api.setConfig.mockReset().mockResolvedValue({ success: true })
  env.api.getRemoteStatus.mockReset().mockResolvedValue({ success: true, data: null })
  env.api.onRemoteStatusChange.mockReset().mockReturnValue(vi.fn())
})
afterEach(() => {
  runner.unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('federation gateway setting', () => {
  it('shows the inherited build gateway without saving it or enabling remote access', async () => {
    render()
    await flush()
    const tree = render()
    expect(text(tree)).toContain('Using the built-in gateway')
    expect(text(tree)).toContain(productUrl)
    expect(text(tree)).toContain('Leave empty to use the built-in gateway.')
    expect(text(tree)).not.toContain('Leave empty for LAN-only teams.')
    expect(input(tree).props!.value).toBe('')
    expect(input(tree).props!.placeholder).toBe(productUrl)
    expect(input(tree).props!.className).toContain('min-w-0')
    expect(env.api.getConfig).toHaveBeenCalledTimes(1)
    expect(env.api.getConfig).toHaveBeenCalledWith()
    expect(env.api.setConfig).not.toHaveBeenCalled()
    expect(setConfig).not.toHaveBeenCalled()
  })

  it('keeps a saved custom gateway in the input and labels the build gateway as a default', async () => {
    render('https://custom.example.test/')
    await flush()
    const tree = render('https://custom.example.test/')
    expect(input(tree).props!.value).toBe('https://custom.example.test/')
    expect(text(tree)).toContain('Built-in gateway')
    expect(text(tree)).not.toContain('Using the built-in gateway')
  })

  it('does not pin the build gateway when saving an untouched empty override', async () => {
    render()
    await flush()
    await save(render()).props!.onClick()
    expect(env.api.setConfig).toHaveBeenCalledWith({ federation: { gatewayUrl: '' } })
    expect(setConfig).toHaveBeenCalledWith({ federation: { gatewayUrl: '' } })
  })

  it('clears a custom override with a JSON-safe empty string to restore inheritance', async () => {
    input(render('https://custom.example.test/')).props!.onChange({ target: { value: '  ' } })
    await flush()
    await save(render('https://custom.example.test/')).props!.onClick()
    expect(env.api.setConfig).toHaveBeenCalledWith({ federation: { gatewayUrl: '' } })
    expect(input(render()).props!.value).toBe('')
    expect(text(render())).toContain('Using the built-in gateway')
  })

  it('shows LAN-only guidance only after confirming the build has no default', async () => {
    env.api.getConfig.mockResolvedValue(metadata(null))
    expect(text(render())).not.toContain('Leave empty for LAN-only teams.')
    await flush()
    expect(text(render())).toContain('Leave empty for LAN-only teams.')
    expect(text(render())).not.toContain('Using the built-in gateway')
  })

  it('does not overwrite a draft when build metadata arrives late', async () => {
    let resolve!: (value: ReturnType<typeof metadata>) => void
    env.api.getConfig.mockReturnValue(new Promise(yes => { resolve = yes }))
    input(render()).props!.onChange({ target: { value: 'https://draft.example.test/' } })
    resolve(metadata(productUrl))
    await flush()
    expect(input(render()).props!.value).toBe('https://draft.example.test/')
  })

  it('does not report a rejected save as saved or update the app settings', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    env.api.setConfig.mockResolvedValue({ success: false, error: 'Not saved' })
    input(render()).props!.onChange({ target: { value: 'https://custom.example.test/' } })
    await flush()
    await save(render()).props!.onClick()
    expect(setConfig).not.toHaveBeenCalled()
    expect(text(render())).toContain('Not saved')
    expect(text(render())).not.toMatch(/\bSaved\b/)
  })

  it('locks the draft while a save is in flight', async () => {
    let resolve!: (value: { success: boolean }) => void
    env.api.setConfig.mockReturnValue(new Promise(yes => { resolve = yes }))
    render()
    await flush()
    const saving = save(render()).props!.onClick()
    const tree = render()
    expect(input(tree).props!.disabled).toBe(true)
    expect(nodes(tree).find(node => node.type === 'button' && text(node).trim() === 'Saving...')!.props!.disabled).toBe(true)
    resolve({ success: true })
    await saving
    expect(input(render()).props!.disabled).toBe(false)
  })

  it('does not claim LAN-only behavior when the metadata request fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    env.api.getConfig.mockRejectedValue(new Error('offline'))
    render()
    await flush()
    expect(text(render())).not.toContain('Leave empty for LAN-only teams.')
    expect(log).toHaveBeenCalledWith('[RemoteAccessSection] Failed to load gateway default:', expect.any(Error))
  })

  it('ignores metadata that arrives after unmount', async () => {
    let resolve!: (value: ReturnType<typeof metadata>) => void
    env.api.getConfig.mockReturnValue(new Promise(yes => { resolve = yes }))
    render()
    runner.unmount()
    const state = [...runner.values]
    resolve(metadata(productUrl))
    await flush()
    expect(runner.values).toEqual(state)
  })
})
