import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as unknown as HookRunner,
  clearBrowserData: vi.fn(),
}))
class HookRunner {
  values: unknown[] = []
  index = 0
  state(initial: unknown) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [this.values[index], (update: unknown) => { this.values[index] = update }]
  }
  ref(initial: unknown) { return this.state({ current: initial })[0] }
  render() {
    this.index = 0
    env.runner = this
    return SystemSection({ config: null, setConfig: vi.fn() })
  }
}
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => env.runner.state(initial),
  useRef: (initial: unknown) => env.runner.ref(initial),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}))
vi.mock('../../../src/renderer/api', () => ({ api: { clearBrowserData: env.clearBrowserData } }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/hooks/useSecurityPolicy', () => ({ useSecurityPolicy: () => null }))
import { SystemSection } from '../../../src/renderer/components/settings/SystemSection'
import { ConfirmDialog } from '../../../src/renderer/components/ui/ConfirmDialog'

type Node = { type?: unknown; props: Record<string, any> }
function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}
const text = (tree: unknown) => nodes(tree).flatMap(node => [node.props?.children].flat(Infinity)).filter(child => typeof child === 'string').join(' ')
function control(tree: unknown) {
  const result = nodes(tree).find(node => node.type === 'button' && /Clear browser data|Clearing browser data/.test(text(node)))
  expect(result, 'Settings exposes the explicit browser cleanup action').toBeDefined()
  return result!
}
function dialog(tree: unknown) { return nodes(tree).find(node => node.type === ConfirmDialog)! }
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
beforeEach(() => { env.clearBrowserData.mockReset().mockResolvedValue({ success: true }) })

describe('System Settings browser cleanup', () => {
  it('warns about every shared login including digital humans, and cancellation has no effect', async () => {
    const runner = new HookRunner()
    const pending = control(runner.render()).props.onClick()
    const confirmation = dialog(runner.render())
    expect(confirmation.props.message).toContain('ALL')
    expect(confirmation.props.message).toContain('digital humans')
    expect(confirmation.props.message).toContain('Halo data')
    expect(env.clearBrowserData).not.toHaveBeenCalled()
    confirmation.props.onCancel()
    await pending
    expect(env.clearBrowserData).not.toHaveBeenCalled()
    expect(control(runner.render()).props.disabled).toBe(false)
  })

  it('prevents duplicate confirmation and requests, waits for completion, then allows repetition', async () => {
    let finish!: (value: unknown) => void
    env.clearBrowserData.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const runner = new HookRunner()
    const click = control(runner.render()).props.onClick
    const pending = click()
    await click()
    dialog(runner.render()).props.onConfirm()
    await settle()
    await click()
    expect(env.clearBrowserData).toHaveBeenCalledOnce()
    expect(control(runner.render()).props.disabled).toBe(true)
    expect(text(runner.render())).not.toContain('Browser data cleared.')
    finish({ success: true })
    await pending
    expect(text(runner.render())).toContain('Browser data cleared.')
    const repeated = control(runner.render()).props.onClick()
    dialog(runner.render()).props.onConfirm()
    await repeated
    expect(env.clearBrowserData).toHaveBeenCalledTimes(2)
  })

  it.each(['response', 'rejection'])('shows %s failure without false success and permits retry', async kind => {
    if (kind === 'response') env.clearBrowserData.mockResolvedValueOnce({ success: false, error: 'Native failure' })
    else env.clearBrowserData.mockRejectedValueOnce(new Error('IPC unavailable'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runner = new HookRunner()
    const pending = control(runner.render()).props.onClick()
    dialog(runner.render()).props.onConfirm()
    await pending
    expect(text(runner.render())).toContain('Could not clear all browser data. Please try again.')
    expect(text(runner.render())).not.toContain('Browser data cleared.')
    expect(control(runner.render()).props.disabled).toBe(false)
    log.mockRestore()
  })
})
