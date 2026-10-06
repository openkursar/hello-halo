import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

const env = vi.hoisted(() => ({ runner: null as any, remote: false, api: {} as any, app: {} as any }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => env.runner.state(initial),
  useRef: (initial: any) => env.runner.ref(initial),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => env.runner.effect(effect, deps),
}))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }), getCurrentLanguage: () => 'en' }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: () => env.app }))
vi.mock('../../../src/renderer/components/settings/ProviderSelector', () => ({ ProviderSelector: () => null }))
vi.mock('../../../src/renderer/components/settings/DelegatedLoginDialog', () => ({ DelegatedLoginDialog: () => null }))
vi.mock('../../../src/renderer/components/icons/BrandIcons', () => ({ getBrandIcon: () => null }))
vi.mock('../../../src/renderer/components/icons/ProviderIconTile', () => ({ ProviderIconTile: () => null }))
vi.mock('../../../src/renderer/components/setup/LoginSelector', () => ({ LoginSelector: () => null }))
vi.mock('../../../src/renderer/components/setup/SetupProviderConfig', () => ({ SetupProviderConfig: () => null }))
vi.mock('../../../src/renderer/components/setup/PreferencesStep', () => ({ PreferencesStep: () => null }))

import { AISourcesSection } from '../../../src/renderer/components/settings/AISourcesSection'
import { SetupPage } from '../../../src/renderer/pages/SetupPage'
import { LoginSelector } from '../../../src/renderer/components/setup/LoginSelector'
import { PreferencesStep } from '../../../src/renderer/components/setup/PreferencesStep'
import { CLI_DELEGATED_PROVIDER_ID } from '../../../src/shared/constants/claude-models'
import { AppModelSelector } from '../../../src/renderer/components/apps/AppModelSelector'
import { OAuthRedirectLogin } from '../../../src/renderer/components/ai-config/OAuthRedirectLogin'

class ComponentRunner {
  values: any[] = []
  effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  pending: (() => void)[] = []
  index = 0
  state(initial: any) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial
    return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }]
  }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
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
  render(component: () => ReactElement | null) {
    this.index = 0
    env.runner = this
    const tree = component()
    this.pending.splice(0).forEach(effect => effect())
    return tree
  }
  unmount() { for (const effect of this.effects.values()) effect.cleanup?.() }
}
/** Hook-free child components render inline so their markup is part of the tree. */
const INLINE_COMPONENTS = new Set<unknown>([OAuthRedirectLogin])
function children(tree: any): any[] {
  return INLINE_COMPONENTS.has(tree.type) ? [tree.type(tree.props)] : [tree.props?.children].flat(Infinity)
}
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...children(tree).flatMap(nodes)]
}
function text(tree: any): string {
  if (typeof tree === 'string') return tree
  if (!tree || typeof tree !== 'object') return ''
  return children(tree).map(text).join(' ').replace(/\s+/g, ' ').trim()
}
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && text(node).includes(label))
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const provider = (type: string, preset?: any) => ({ type, displayName: type, description: `${type} description`, preset, enabled: true, recommended: false, icon: 'globe', iconBgColor: '' })
const config = () => ({ aiSources: { version: 2, currentId: 'account-1', sources: [
  { id: 'account-1', provider: 'external-pkce', authType: 'oauth', name: 'Personal account', user: { name: `${'long'.repeat(25)}@example.com` }, model: 'model-1' },
  { id: 'cli', provider: CLI_DELEGATED_PROVIDER_ID, authType: 'delegated', name: 'CLI', model: 'model-1' },
  { id: 'preset', provider: 'custom', isPreset: true, apiUrl: 'https://preset.example', name: 'Preset', authType: 'api-key', model: 'model-1' },
] } } as any)
const start = (loginId: string, redirect = true) => ({ success: true, data: { loginId, loginUrl: 'https://issuer.example/login', state: 'csrf', ...(redirect ? { redirectUri: 'https://callback.example/login' } : { userCode: 'ABCD', verificationUri: 'https://issuer.example/device' }) } })
const providerOwnedStart = () => ({ success: true, data: { loginId: 'owned-login', loginUrl: 'https://issuer.example/login', state: 'original-state' } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

beforeEach(() => {
  env.remote = false
  Object.assign(env.api, {
    isRemoteMode: () => env.remote,
    authGetProviders: vi.fn().mockResolvedValue({ success: true, data: [provider('external-pkce'), provider('device-provider'), provider(CLI_DELEGATED_PROVIDER_ID), provider('preset', { baseUrl: 'https://preset.example' })] }),
    authStartLogin: vi.fn().mockResolvedValue(start('owned-login')),
    authCompleteLogin: vi.fn().mockResolvedValue({ success: true, data: { success: true, sourceId: 'account-2', sourceIds: ['account-2'] } }),
    authOpenLoginWindow: vi.fn().mockResolvedValue({ success: true }),
    authCancelLogin: vi.fn().mockResolvedValue({ success: true }),
    authLogout: vi.fn().mockResolvedValue({ success: true }),
    aiSourcesUpdateSource: vi.fn().mockResolvedValue({ success: true }),
    getConfig: vi.fn().mockResolvedValue({ success: true, data: config() }),
    setConfig: vi.fn().mockResolvedValue({ success: true }),
    onAuthLoginProgress: vi.fn(),
  })
  env.app = { config: { isFirstLaunch: false }, setConfig: vi.fn(), enterApp: vi.fn().mockResolvedValue(undefined) }
})

afterEach(() => { vi.restoreAllMocks() })

async function settings() {
  const runner = new ComponentRunner()
  const setConfig = vi.fn()
  const render = () => runner.render(() => AISourcesSection({ config: config(), setConfig }))
  render()
  await flush()
  return { runner, render, setConfig }
}

describe('deleted account model recovery', () => {
  it.each([false, true])('keeps a missing pin visible and unchanged with empty sources=%s', empty => {
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    env.app.config.aiSources = { version: 2, currentId: empty ? null : 'b', sources: empty ? [] : [{ id: 'b', name: 'Other account', model: 'b-model', availableModels: [{ id: 'b-model', name: 'B model' }] }] }
    env.app.navigate = vi.fn()
    const onChange = vi.fn()
    const runner = new ComponentRunner()
    const render = () => runner.render(() => AppModelSelector({ modelSourceId: 'removed', modelId: 'old-model', onChange }))
    const tree = render()
    expect(text(tree)).toContain('Account removed. Choose another account.')
    expect(text(tree)).not.toContain('B model')
    expect(onChange).not.toHaveBeenCalled()
    expect(nodes(tree).filter(node => node.type === 'button').every(node => !nodes(node.props.children).some(child => child.type === 'button'))).toBe(true)
    button(tree, 'Account removed').props.onClick()
    const options = render()
    if (empty) {
      button(options, 'Configure AI Source').props.onClick()
      expect(env.app.navigate).toHaveBeenCalledWith('settings')
      expect(onChange).not.toHaveBeenCalled()
    }
    nodes(render()).find(node => node.type === 'button' && node.props['aria-label'] === 'Reset to global').props.onClick()
    expect(onChange).toHaveBeenCalledWith(undefined, undefined)
    runner.unmount()
    vi.unstubAllGlobals()
  })
})

describe('AI sources OAuth UI', () => {
  it('keeps OAuth entries available to add accounts while excluding the existing CLI slot and preset', async () => {
    const { render } = await settings()
    const tree = render()
    expect(button(tree, 'external-pkce Add another account')).toBeDefined()
    expect(button(tree, `${CLI_DELEGATED_PROVIDER_ID} description`)).toBeUndefined()
    expect(button(tree, 'preset description')).toBeUndefined()
    expect(env.api.onAuthLoginProgress).not.toHaveBeenCalled()
  })

  it('targets the source on reauthentication and uses a generic redirect dialog', async () => {
    const { render } = await settings()
    let tree = render()
    nodes(tree).find(node => node.props?.onClick && text(node).includes('Personal account') && node.type === 'div').props.onClick()
    tree = render()
    await button(tree, 'Reauthenticate').props.onClick()
    expect(env.api.authStartLogin).toHaveBeenCalledWith('external-pkce', 'account-1')
    tree = render()
    expect(button(tree, 'Open Login Window')).toBeDefined()
    await button(tree, 'Open Login Window').props.onClick()
    expect(env.api.authOpenLoginWindow).toHaveBeenCalledWith('external-pkce', 'owned-login')
  })

  it('renames only source metadata without resending credentials or switching accounts', async () => {
    const { render } = await settings()
    let tree = render()
    nodes(tree).find(node => node.props?.onClick && text(node).includes('Personal account') && node.type === 'div').props.onClick()
    await button(render(), 'Rename').props.onClick()
    tree = render()
    nodes(tree).find(node => node.type === 'input' && node.props['aria-label'] === 'Account name').props.onChange({ target: { value: ' Work account ' } })
    await button(render(), 'Save').props.onClick()
    expect(env.api.aiSourcesUpdateSource).toHaveBeenCalledWith('account-1', { name: 'Work account' })
    expect(env.api.authStartLogin).not.toHaveBeenCalled()
  })

  it('truncates a long signed-in email inside a shrinkable card name column', async () => {
    const { render } = await settings()
    const email = config().aiSources.sources[0].user.name
    const node = nodes(render()).find(entry => entry.props?.title === email)
    expect(node.props.className).toContain('truncate')
    const header = nodes(render()).find(entry => entry.props?.className === 'flex-1 min-w-0' && text(entry).includes(email))
    expect(header).toBeDefined()
  })

  it('shows remote manual login and propagates provider and login ID on submission', async () => {
    env.remote = true
    const { render } = await settings()
    await button(render(), 'external-pkce Add another account').props.onClick()
    let tree = render()
    expect(text(tree)).toContain('Manual login')
    expect(button(tree, 'Open Login Window')).toBeUndefined()
    nodes(tree).find(node => node.type === 'input').props.onChange({ target: { value: ' code#csrf ' } })
    tree = render()
    await button(tree, 'Complete Login').props.onClick()
    expect(env.api.authCompleteLogin).toHaveBeenCalledWith('external-pkce', 'code#csrf', 'owned-login')
  })

  it.each([false, true])('automatically waits for provider-owned login before reloading config (remote=%s)', async remote => {
    env.remote = remote
    env.api.authStartLogin.mockResolvedValue(providerOwnedStart())
    const completion = deferred<any>()
    const loadedConfig = deferred<any>()
    env.api.authCompleteLogin.mockReturnValue(completion.promise)
    env.api.getConfig.mockReturnValue(loadedConfig.promise)
    const { runner, render, setConfig } = await settings()
    const pending = button(render(), 'external-pkce Add another account').props.onClick()
    await flush()
    expect(env.api.authStartLogin).toHaveBeenCalledWith('external-pkce', undefined)
    expect(env.api.authCompleteLogin).toHaveBeenCalledTimes(1)
    expect(env.api.authCompleteLogin).toHaveBeenCalledWith('external-pkce', 'original-state', 'owned-login')
    const waiting = render()
    expect(text(waiting)).toContain('Waiting for login...')
    expect(text(waiting)).not.toContain('Manual login')
    expect(text(waiting)).not.toContain('Your code')
    expect(button(waiting, 'Open Login Window')).toBeUndefined()
    expect(button(waiting, 'Complete Login')).toBeUndefined()
    expect(nodes(waiting).some(node => node.type === 'input' || node.type === 'iframe')).toBe(false)
    expect(button(waiting, 'Cancel')).toBeDefined()
    expect(env.api.authOpenLoginWindow).not.toHaveBeenCalled()
    expect(env.api.onAuthLoginProgress).not.toHaveBeenCalled()
    expect(env.api.getConfig).not.toHaveBeenCalled()
    expect(setConfig).not.toHaveBeenCalled()
    completion.resolve({ success: true, data: { success: true, sourceId: 'account-2' } })
    await flush()
    expect(env.api.getConfig).toHaveBeenCalledTimes(1)
    expect(setConfig).not.toHaveBeenCalled()
    const updated = config()
    loadedConfig.resolve({ success: true, data: updated })
    await pending
    expect(setConfig).toHaveBeenCalledTimes(1)
    expect(setConfig).toHaveBeenCalledWith(updated)
    expect(text(render())).not.toContain('Waiting for login...')
    runner.unmount()
    expect(env.api.authCancelLogin).not.toHaveBeenCalled()
  })

  it('cancels a device flow by its own ID and ignores a late completion', async () => {
    env.api.authStartLogin.mockResolvedValue(start('device-login', false))
    let complete!: (value: any) => void
    env.api.authCompleteLogin.mockReturnValue(new Promise(resolve => { complete = resolve }))
    const { render, setConfig } = await settings()
    const pending = button(render(), 'device-provider description').props.onClick()
    await flush()
    await button(render(), 'Cancel').props.onClick()
    expect(env.api.authCancelLogin).toHaveBeenCalledWith('device-provider', 'device-login')
    complete({ success: true })
    await pending
    expect(setConfig).not.toHaveBeenCalled()
    expect(env.api.getConfig).not.toHaveBeenCalled()
  })

  it('cancels a start result arriving after unmount without completing it', async () => {
    let resolveStart!: (value: any) => void
    env.api.authStartLogin.mockReturnValue(new Promise(resolve => { resolveStart = resolve }))
    const { runner, render } = await settings()
    const pending = button(render(), 'external-pkce Add another account').props.onClick()
    runner.unmount()
    resolveStart(start('late-login'))
    await pending
    expect(env.api.authCancelLogin).toHaveBeenCalledWith('external-pkce', 'late-login')
    expect(env.api.authCompleteLogin).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'thrown'])('logs %s cleanup failures for a late settings login without leaking details', async failure => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resolveStart!: (value: any) => void
    env.api.authStartLogin.mockReturnValue(new Promise(resolve => { resolveStart = resolve }))
    if (failure === 'rejected') env.api.authCancelLogin.mockResolvedValue({ success: false, error: 'accessToken=secret' })
    else env.api.authCancelLogin.mockRejectedValue(new Error('accessToken=secret'))
    const { runner, render, setConfig } = await settings()
    const pending = button(render(), 'external-pkce Add another account').props.onClick()
    runner.unmount()
    resolveStart(start('late-login'))
    await pending
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[OAuthLogin] Could not cancel login for external-pkce')
    expect(env.api.authCancelLogin).toHaveBeenCalledWith('external-pkce', 'late-login')
    expect(env.api.authCompleteLogin).not.toHaveBeenCalled()
    expect(setConfig).not.toHaveBeenCalled()
  })

  it('displays start and completion failures instead of only logging them', async () => {
    env.api.authStartLogin.mockResolvedValue({ success: false, error: 'Provider is busy' })
    const { render } = await settings()
    await button(render(), 'external-pkce Add another account').props.onClick()
    expect(text(nodes(render()).find(node => node.props?.role === 'alert'))).toContain('Provider is busy')
    env.api.authStartLogin.mockResolvedValue(start('new-login'))
    env.api.authOpenLoginWindow.mockResolvedValue({ success: false, error: 'Login timed out' })
    await button(render(), 'external-pkce Add another account').props.onClick()
    await button(render(), 'Open Login Window').props.onClick()
    expect(text(nodes(render()).find(node => node.props?.role === 'alert'))).toContain('Login timed out')
  })
})

describe('first-run setup OAuth ownership', () => {
  it('preserves the first-launch preferences step', () => {
    env.app.config.isFirstLaunch = true
    const runner = new ComponentRunner()
    const render = () => runner.render(SetupPage)
    expect(render()!.type).toBe(PreferencesStep)
    render()!.props.onContinue()
    expect(nodes(render()).some(node => node.type === LoginSelector)).toBe(true)
  })

  it('uses generic PKCE and enters the app only after its own completion', async () => {
    const runner = new ComponentRunner()
    const render = () => runner.render(SetupPage)
    await nodes(render()).find(node => node.type === LoginSelector).props.onSelectProvider('external-pkce')
    await button(render(), 'Open Login Window').props.onClick()
    expect(env.api.authOpenLoginWindow).toHaveBeenCalledWith('external-pkce', 'owned-login')
    expect(env.app.setConfig).toHaveBeenCalledTimes(1)
    expect(env.app.enterApp).toHaveBeenCalledTimes(1)
    expect(env.api.onAuthLoginProgress).not.toHaveBeenCalled()
  })

  it.each([false, true])('automatically waits for provider-owned login before loading config and entering the app (remote=%s)', async remote => {
    env.remote = remote
    env.api.authStartLogin.mockResolvedValue(providerOwnedStart())
    const completion = deferred<any>()
    const loadedConfig = deferred<any>()
    env.api.authCompleteLogin.mockReturnValue(completion.promise)
    env.api.getConfig.mockReturnValue(loadedConfig.promise)
    const runner = new ComponentRunner()
    const render = () => runner.render(SetupPage)
    const pending = nodes(render()).find(node => node.type === LoginSelector).props.onSelectProvider('external-pkce')
    await flush()
    expect(env.api.authStartLogin).toHaveBeenCalledTimes(1)
    expect(env.api.authStartLogin).toHaveBeenCalledWith('external-pkce', undefined)
    expect(env.api.authCompleteLogin).toHaveBeenCalledTimes(1)
    expect(env.api.authCompleteLogin).toHaveBeenCalledWith('external-pkce', 'original-state', 'owned-login')
    const waiting = render()
    expect(text(waiting)).toContain('Waiting for login...')
    expect(text(waiting)).toContain('Please complete login in your browser')
    expect(text(waiting)).not.toContain('Manual login')
    expect(text(waiting)).not.toContain('Enter this code')
    expect(button(waiting, 'Open Login Window')).toBeUndefined()
    expect(button(waiting, 'Complete Login')).toBeUndefined()
    expect(nodes(waiting).some(node => node.type === 'input' || node.type === 'iframe')).toBe(false)
    expect(button(waiting, 'Cancel')).toBeDefined()
    expect(env.api.authOpenLoginWindow).not.toHaveBeenCalled()
    expect(env.api.onAuthLoginProgress).not.toHaveBeenCalled()
    expect(env.api.getConfig).not.toHaveBeenCalled()
    expect(env.app.setConfig).not.toHaveBeenCalled()
    expect(env.app.enterApp).not.toHaveBeenCalled()
    completion.resolve({ success: true, data: { success: true, sourceId: 'account-2' } })
    await flush()
    expect(env.api.getConfig).toHaveBeenCalledTimes(1)
    expect(env.app.setConfig).not.toHaveBeenCalled()
    expect(env.app.enterApp).not.toHaveBeenCalled()
    const updated = config()
    loadedConfig.resolve({ success: true, data: updated })
    await pending
    expect(env.app.setConfig).toHaveBeenCalledTimes(1)
    expect(env.app.setConfig).toHaveBeenCalledWith(updated)
    expect(env.app.enterApp).toHaveBeenCalledTimes(1)
    expect(env.app.setConfig.mock.invocationCallOrder[0]).toBeLessThan(env.app.enterApp.mock.invocationCallOrder[0])
    runner.unmount()
    expect(env.api.authCancelLogin).not.toHaveBeenCalled()
  })

  it('shows an app-entry failure after successful authentication instead of leaving setup stuck', async () => {
    env.app.enterApp.mockRejectedValue(new Error('Unable to open workspace'))
    const runner = new ComponentRunner()
    const render = () => runner.render(SetupPage)
    await nodes(render()).find(node => node.type === LoginSelector).props.onSelectProvider('external-pkce')
    await button(render(), 'Open Login Window').props.onClick()
    expect(text(nodes(render()).find(node => node.props?.role === 'alert'))).toContain('Unable to open workspace')
    expect(nodes(render()).some(node => node.type === LoginSelector)).toBe(true)
    expect(env.api.authCancelLogin).toHaveBeenCalledWith('external-pkce', 'owned-login')
    expect(env.app.enterApp).toHaveBeenCalledTimes(1)
  })

  it.each(['rejected', 'thrown'])('logs %s cleanup failures for a late setup login without leaking details', async failure => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resolveStart!: (value: any) => void
    env.api.authStartLogin.mockReturnValue(new Promise(resolve => { resolveStart = resolve }))
    if (failure === 'rejected') env.api.authCancelLogin.mockResolvedValue({ success: false, error: 'accessToken=secret' })
    else env.api.authCancelLogin.mockRejectedValue(new Error('accessToken=secret'))
    const runner = new ComponentRunner()
    const render = () => runner.render(SetupPage)
    const pending = nodes(render()).find(node => node.type === LoginSelector).props.onSelectProvider('external-pkce')
    runner.unmount()
    resolveStart(start('late-login'))
    await pending
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[OAuthLogin] Could not cancel login for external-pkce')
    expect(env.api.authCancelLogin).toHaveBeenCalledWith('external-pkce', 'late-login')
    expect(env.api.authCompleteLogin).not.toHaveBeenCalled()
    expect(env.app.enterApp).not.toHaveBeenCalled()
  })

  it('ignores completion after cancellation and passes ownership for manual remote login', async () => {
    env.remote = true
    const runner = new ComponentRunner()
    const render = () => runner.render(SetupPage)
    await nodes(render()).find(node => node.type === LoginSelector).props.onSelectProvider('external-pkce')
    expect(button(render(), 'Open Login Window')).toBeUndefined()
    nodes(render()).find(node => node.type === 'input').props.onChange({ target: { value: 'code#csrf' } })
    let resolveComplete!: (value: any) => void
    env.api.authCompleteLogin.mockReturnValue(new Promise(resolve => { resolveComplete = resolve }))
    const pending = button(render(), 'Complete Login').props.onClick()
    await button(render(), 'Cancel').props.onClick()
    resolveComplete({ success: true })
    await pending
    expect(env.api.authCompleteLogin).toHaveBeenCalledWith('external-pkce', 'code#csrf', 'owned-login')
    expect(env.api.authCancelLogin).toHaveBeenCalledWith('external-pkce', 'owned-login')
    expect(env.app.enterApp).not.toHaveBeenCalled()
  })
})
