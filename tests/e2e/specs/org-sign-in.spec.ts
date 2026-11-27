import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { terminalProbe, parseProbe } from '../fixtures/cli-tools-entries'
import { writePackage } from '../../unit/services/cli-tools/helpers'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElectronApplication, Locator, Page, TestInfo } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { acceptance, expect, sendAcceptanceMessage, test } from '../fixtures/acceptance-app'
import { navigateToChat, navigateToSettings, setTheme } from '../fixtures/helpers'

const mockProduct = fileURLToPath(new URL('../../fixtures/enterprise-identity-mock/product.mock.json', import.meta.url))
const unconfiguredProduct = fileURLToPath(new URL('../../../product.example.json', import.meta.url))
const boundCommand = 'org-bound'
const unboundCommand = 'org-unbound'

function createOrgPresets(profile: string): string {
  const dir = join(profile, 'org-cli-presets')
  mkdirSync(dir, { recursive: true })
  for (const [id, name] of [['example-org.mock-tool', boundCommand], ['example-org.unbound', unboundCommand]]) {
    writePackage(dir, {
      id, commands: [{ name, entry: 'bin/tool.cjs' }],
      payload: { 'bin/tool.cjs': `console.log(process.env.EXAMPLE_ORG_MOCK_TOKEN ? 'credential-present' : 'credential-absent')\n` },
    })
  }
  return dir
}
const capabilityLabels = ['Models', 'Internal systems', 'Mail']
const indicator = (page: Page) => page.getByTestId('org-sign-in-status')
const settingsCard = (page: Page) => page.getByTestId('org-account-card')
const signInOption = (page: Page) => page.getByTestId('org-sign-in-option')
const rows = (list: Locator, status: string) => list.getByTestId('org-capability').and(list.locator(`[data-status="${status}"]`))
const orgCase = (name: string) => ({ annotation: { type: 'acceptance', description: JSON.stringify({ caseId: `settings.organization-sign-in.${name}`, evidence: 'app-e2e', mode: 'none', variant: {} }) } })

function mockEnvironment(restore: boolean) {
  return {
    forProfile: (profile: string) => ({
      HALO_ORG_MOCK_AUTO: 'never',
      HALO_ORG_MOCK_TTL_MS: '1800000',
      HALO_ORG_MOCK_RESTORE: restore ? '1' : '0',
      HALO_ORG_MOCK_CONTROL_FILE: join(profile, 'org-mock-control.json'),
    }),
  }
}

type ControlAction = { action: 'confirm'; method: 'phone' } | { action: 'expire'; capability: 'mail' }
type RenewalWindow = { halo: HaloAPI; renewalResult: ReturnType<HaloAPI['enterpriseIdentitySignIn']> }

async function control(profile: string, action: ControlAction) {
  const { port, token } = JSON.parse(readFileSync(join(profile, 'org-mock-control.json'), 'utf8')) as { port: number; token: string }
  const response = await fetch(`http://127.0.0.1:${port}/control`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
    signal: AbortSignal.timeout(5000),
  })
  const body = await response.json()
  expect(response.status, `Mock action ${action.action}: ${JSON.stringify(body)}`).toBe(200)
  return body
}

function readState(page: Page) {
  return page.evaluate(async () => {
    const result = await (window as unknown as { halo: HaloAPI }).halo.enterpriseIdentityState()
    if (!result.success || !result.data) throw new Error(result.error || 'Missing organization sign-in state')
    return result.data
  })
}

async function openCard(page: Page) {
  const toggle = settingsCard(page).getByRole('button', { name: 'Example Org details' })
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  return settingsCard(page)
}

async function signOutFromCard(page: Page) {
  await (await openCard(page)).getByRole('button', { name: 'Sign out', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('will stop working until you sign in again.')
  await dialog.getByRole('button', { name: 'Sign out', exact: true }).click()
}

async function openLogin(app: ElectronApplication, open: () => Promise<void>) {
  const previous = app.windows()
  const [login] = await Promise.all([app.waitForEvent('window', { predicate: candidate => !previous.includes(candidate) }), open()])
  await expect(login.getByRole('heading', { name: 'Sign in to Example Org' })).toBeVisible()
  expect(app.windows()).toContain(login)
  return login
}

async function screenshotSizes(page: Page, name: string, target: Locator, info: TestInfo, prepare?: () => Promise<void>) {
  const original = page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const evidenceDirectory = process.env.HALO_ORG_SIGN_IN_SCREENSHOTS
  if (evidenceDirectory) mkdirSync(evidenceDirectory, { recursive: true })
  try {
    for (const theme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await setTheme(page, theme)
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport)
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(viewport.width)
        await prepare?.()
        await target.scrollIntoViewIfNeeded()
        const file = `${name}-${theme}-${viewport.width}.png`
        const path = evidenceDirectory ? join(evidenceDirectory, file) : info.outputPath(file)
        await page.screenshot({ path, animations: 'disabled' })
        await info.attach(file, { path, contentType: 'image/png' })
        const fits = await target.evaluate(element => {
          const { left, right, top, bottom } = element.getBoundingClientRect()
          if (left < 0 || right > window.innerWidth || top < 0 || bottom > window.innerHeight) return false
          return [left + 8, right - 8].every(x => element.contains(document.elementFromPoint(x, (top + bottom) / 2)))
            && element.scrollWidth <= element.clientWidth + 1
        })
        expect.soft(fits, `${name} should fit and stay unobscured at ${viewport.width}px in ${theme} mode`).toBe(true)
      }
    }
  } finally {
    await page.setViewportSize(original)
    await page.emulateMedia({ colorScheme: null })
    await setTheme(page, 'dark')
  }
}

test.describe('configured organization', () => {
  test.use({ productConfigPath: mockProduct, electronEnvironment: mockEnvironment(false) })

  test.describe('preselected first-run model', () => {
    const expectedModel = 'gpt-4o-mini'
    test.use({ firstLaunch: 'with-model', selectedModel: expectedModel })
    for (const choice of ['skip', 'confirm'] as const) {
      test(`first conversation uses the selected model after ${choice}`, async ({ acceptanceApp, window, model }, info) => {
        const signIn = window.getByRole('button', { name: 'Sign in to Example Org', exact: true })
        await expect(signIn).toBeVisible()
        const selected = () => {
          const { aiSources, api } = JSON.parse(readFileSync(join(acceptanceApp.profile, '.halo/config.json'), 'utf8'))
          return { current: aiSources.currentId, selected: aiSources.sources.find((s: { id: string }) => s.id === aiSources.currentId)?.model, first: aiSources.sources[0].model, fallback: api.model }
        }
        const before = selected()
        expect(before).toMatchObject({ current: 'acceptance-selected', selected: expectedModel, first: 'gpt-4o' })
        if (choice === 'skip') await window.getByRole('button', { name: 'Skip organization sign-in' }).click()
        else {
          await openLogin(acceptanceApp.app, () => signIn.click())
          expect((await control(acceptanceApp.profile, { action: 'confirm', method: 'phone' })).outcome).toBe('succeeded')
        }
        const message = `Check my first local conversation after ${choice}.`
        const reply = 'Your selected model received the message.'
        model.respond(() => ({ text: reply }))
        await sendAcceptanceMessage(window, message)
        await expect(window.locator('.message-assistant').last()).toContainText(reply)
        const wireModels = model.exchanges.filter(x => x.request.lastUserText.includes(message)).map(x => x.request.body.model)
        expect(wireModels.length).toBeGreaterThan(0)
        expect([...new Set(wireModels)]).toEqual([expectedModel])
        expect(selected()).toEqual(before)
        await info.attach('first-turn-model', { body: JSON.stringify({ choice, before, after: selected(), wireModels }), contentType: 'application/json' })
      })
    }
  })

  for (const entry of ['home', 'first-run', 'no-model'] as const) test.describe(entry, () => {
    test.use({ firstLaunch: entry === 'home' ? false : entry === 'no-model' ? 'without-model' : 'with-model' })
    test(`named organization sign-in from ${entry}`, orgCase(entry), async ({ acceptanceApp }, info) => {
      const configFile = join(acceptanceApp.profile, '.halo/config.json')
      const readConfig = () => JSON.parse(readFileSync(configFile, 'utf8'))
      const { window, app, profile } = acceptanceApp
      const selection = () => {
        const { aiSources, api } = readConfig()
        return { id: aiSources.currentId, model: aiSources.sources.find((s: { id: string }) => s.id === aiSources.currentId)?.model, fallback: api.model }
      }
      const before = selection()
      if (entry !== 'no-model') expect(before).toMatchObject({ id: 'acceptance-local', model: 'gpt-4o' })
      const action = window.getByRole('button', { name: 'Sign in to Example Org', exact: true })
      await expect(action).toBeVisible()
      if (entry !== 'no-model') await screenshotSizes(window, `organization-${entry}`, action, info)
      const cancelled = await openLogin(app, () => action.click())
      await (await app.browserWindow(cancelled)).evaluate(win => win.close())
      await expect(action).toBeEnabled()
      expect(selection()).toEqual(before)
      if (entry === 'no-model') {
        await window.getByRole('button', { name: 'Skip organization sign-in' }).click()
        await expect(window.getByText('Select a method to start')).toBeVisible()
        await expect(window.getByRole('button', { name: /^Example Org/ })).toContainText('One sign-in for Models, Internal systems, and Mail')
        await expect(window.getByText('Example Cloud', { exact: true })).toHaveCount(0)
        await window.getByRole('button', { name: 'Skip for now' }).click()
        await expect(action).toBeVisible()
      } else {
        await openLogin(app, () => action.click())
        expect((await control(profile, { action: 'confirm', method: 'phone' })).outcome).toBe('succeeded')
        await expect(indicator(window)).toHaveAttribute('data-tone', 'ok')
        await expect(window.locator('textarea').first()).toBeVisible()
      }
      expect(selection()).toEqual(before)
    })
  })

  test('signed-out capabilities are explained without blocking a chat turn', acceptance('settings.organization-sign-in.signed-out'), async ({ acceptanceApp, model, window }, info) => {
    expect(await acceptanceApp.app.evaluate(({ app }) => app.isPackaged)).toBe(false)
    const message = 'Can I chat without signing in to Example Org?'
    const reply = 'Chat still works without organization sign-in.'
    model.respond(() => ({ text: reply }))
    await navigateToChat(window)
    await expect(indicator(window)).toHaveAttribute('data-tone', 'attention')
    await sendAcceptanceMessage(window, message)
    await expect(window.locator('.message-assistant').last()).toContainText(reply)
    expect(model.exchanges.some(exchange => exchange.request.lastUserText.includes(message))).toBe(true)
    await navigateToSettings(window)
    await expect(settingsCard(window)).toHaveCount(0)
    await expect(signInOption(window)).toContainText('Example Org')
    await expect(signInOption(window)).toContainText('One sign-in for Models, Internal systems, and Mail')
    await expect(window.getByText('Example Cloud', { exact: true })).toHaveCount(0)
    await screenshotSizes(window, 'settings-sign-in-option', signInOption(window), info)
  })

  test('sign-in closes only on resolution, one expiry leaves the rest connected, and sign-out clears access', orgCase('lifecycle'), async ({ acceptanceApp, window }, info) => {
    const { app, profile } = acceptanceApp
    await navigateToChat(window)
    await expect(indicator(window)).toHaveAttribute('data-tone', 'attention')
    const login = await openLogin(app, () => indicator(window).click())
    expect((await control(profile, { action: 'confirm', method: 'phone' })).outcome).toBe('succeeded')
    await expect.poll(() => app.windows().includes(login)).toBe(false)
    await expect(indicator(window)).toHaveAttribute('data-tone', 'ok')
    expect(await readState(window)).toMatchObject({ status: 'active', signingIn: false, account: { displayName: 'Example Member' } })

    await navigateToSettings(window)
    await expect(settingsCard(window)).toHaveAttribute('data-status', 'active')
    await expect(signInOption(window)).toHaveCount(0)
    await expect(rows(await openCard(window), 'ready')).toHaveText(capabilityLabels.map(label => `${label}Connected`))

    // With every capability ready, only the IPC entry point can start a redundant sign-in.
    const renewal = await openLogin(app, () => window.evaluate(() => {
      const context = window as unknown as RenewalWindow
      context.renewalResult = context.halo.enterpriseIdentitySignIn()
    }))
    await window.evaluate(() => {
      const halo = (window as unknown as { halo: HaloAPI }).halo
      const stop = halo.onEnterpriseIdentityChanged(state => {
        if (state.capabilities.some(capability => capability.id === 'mail' && capability.status === 'expired')) {
          stop()
          document.documentElement.dataset.mailExpiryReceived = 'true'
        }
      })
    })
    expect((await control(profile, { action: 'expire', capability: 'mail' })).outcome).toBeNull()
    await expect(window.locator('html')).toHaveAttribute('data-mail-expiry-received', 'true')
    await expect(rows(settingsCard(window), 'expired')).toHaveText(['MailExpired, sign in again'])
    expect(app.windows()).toContain(renewal)
    const whileOpen = await readState(window)
    expect(whileOpen).toMatchObject({ status: 'active', signingIn: true, capabilities: [
      { id: 'model', status: 'ready' }, { id: 'intranet', status: 'ready' }, { id: 'mail', status: 'expired' },
    ] })
    const browserWindow = await app.browserWindow(renewal)
    await browserWindow.evaluate(value => value.close())
    expect(await window.evaluate(() => (window as unknown as RenewalWindow).renewalResult)).toMatchObject({ success: true, data: 'cancelled' })
    await expect.poll(() => app.windows().includes(renewal)).toBe(false)
    expect(await readState(window)).toEqual({ ...whileOpen, signingIn: false })
    await navigateToChat(window)
    await expect(indicator(window)).toHaveAttribute('data-tone', 'attention')
    await indicator(window).hover()
    const popover = window.getByTestId('org-sign-in-popover')
    await expect(rows(popover, 'expired')).toHaveText(['MailExpired, sign in again'])
    await expect(rows(popover, 'ready')).toHaveText(['ModelsConnected', 'Internal systemsConnected'])
    await screenshotSizes(window, 'composer-popover-mail-expired', popover, info, async () => {
      await window.keyboard.press('Escape')
      await window.mouse.move(0, 0)
      await indicator(window).hover()
    })
    await window.keyboard.press('Escape')

    await navigateToSettings(window)
    await expect(settingsCard(window)).toContainText('Mail needs signing in again')
    await expect(rows(await openCard(window), 'expired')).toHaveText(['MailExpired, sign in again'])
    await expect(settingsCard(window).getByTestId('org-account-sign-in')).toBeEnabled()
    await screenshotSizes(window, 'settings-card-mail-expired', settingsCard(window), info)
    await signOutFromCard(window)
    await expect(settingsCard(window)).toHaveCount(0)
    await expect(signInOption(window)).toBeVisible()
    expect(await readState(window)).toMatchObject({ status: 'signed-out', signingIn: false })
    await navigateToChat(window)
    await expect(indicator(window)).toHaveAttribute('data-tone', 'attention')
  })
})

test.describe('model account that comes with the sign-in', () => {
  test.use({ productConfigPath: mockProduct, electronEnvironment: mockEnvironment(true) })

  test('is chosen in the organization card, shows its quota in the one composer indicator, and is named before sign-out', orgCase('model-account'), async ({ acceptanceApp }, info) => {
    const configFile = join(acceptanceApp.profile, '.halo/config.json')
    const readConfig = () => JSON.parse(readFileSync(configFile, 'utf8'))
    const window = await acceptanceApp.restart(() => {
      const config = readConfig()
      const now = new Date().toISOString()
      config.aiSources.sources.push({
        id: 'org-account', name: 'Example Cloud', provider: 'example-cloud', authType: 'oauth', managedBy: 'organization',
        accessToken: 'example-token', tokenExpires: Date.now() + 3_600_000, model: 'example-model',
        availableModels: [{ id: 'example-model', name: 'Example model' }], user: { name: 'Example Member' }, createdAt: now, updatedAt: now,
      })
      writeFileSync(configFile, JSON.stringify(config, null, 2))
    })
    await navigateToChat(window)
    await expect(indicator(window)).toHaveAttribute('data-tone', 'ok')
    await navigateToSettings(window)
    const card = settingsCard(window)
    await expect(card).toHaveAttribute('data-ai-source-id', 'org-account')
    await expect(card).toContainText('example-model')
    await expect(window.locator('[data-ai-source-id="org-account"]')).toHaveCount(1)
    await expect(window.getByText('Example Cloud', { exact: true })).toHaveCount(0)
    await expect(signInOption(window)).toHaveCount(0)
    await card.getByRole('button', { name: 'Use Example Org for new chats' }).click()
    await expect.poll(() => readConfig().aiSources.currentId).toBe('org-account')
    await screenshotSizes(window, 'settings-card-model-account', card, info, async () => { await openCard(window) })

    await navigateToChat(window)
    await expect(indicator(window)).toHaveAttribute('aria-label', /Remaining quota: 680 credits/)
    await indicator(window).hover()
    const popover = window.getByTestId('org-sign-in-popover')
    await expect(rows(popover, 'ready')).toHaveText(capabilityLabels.map(label => `${label}Connected`))
    await expect(popover.getByTestId('org-sign-in-quota')).toContainText('680')
    await screenshotSizes(window, 'composer-popover-quota', popover, info, async () => {
      await window.keyboard.press('Escape')
      await window.mouse.move(0, 0)
      await indicator(window).hover()
    })
    await window.keyboard.press('Escape')

    await navigateToSettings(window)
    await (await openCard(window)).getByRole('button', { name: 'Sign out', exact: true }).click()
    const dialog = window.getByRole('alertdialog')
    await expect(dialog).toContainText('Models, Internal systems, and Mail will stop working until you sign in again.')
    await expect(dialog).toContainText('New messages that use example-model will fail.')
    await screenshotSizes(window, 'sign-out-confirmation', dialog, info)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await readState(window)).toMatchObject({ status: 'active' })
  })
})

test.describe('organization tool launchers', () => {
  test.use({ productConfigPath: mockProduct, electronEnvironment: mockEnvironment(false), cliPresetDirectory: { forProfile: createOrgPresets }, isolatedPath: true })

  test('a bound preset launcher receives access only while signed in', orgCase('bound-tool'), async ({ acceptanceApp, window }) => {
    test.skip(process.platform === 'win32', 'The terminal probe uses a POSIX shell')
    await navigateToSettings(window)
    await openLogin(acceptanceApp.app, () => signInOption(window).getByRole('button').click())
    expect((await control(acceptanceApp.profile, { action: 'confirm', method: 'phone' })).outcome).toBe('succeeded')
    await expect.poll(async () => (await readState(window)).boundTools[0]?.access).toBe('ready')
    const commands = [boundCommand, unboundCommand]
    const signedIn = parseProbe((await terminalProbe(window, commands)).text)
    expect(Object.keys(signedIn.bins).sort()).toEqual(commands.slice().sort())
    expect(signedIn.commands).toEqual({ [boundCommand]: 'credential-present', [unboundCommand]: 'credential-absent' })
    await signOutFromCard(window)
    await expect(settingsCard(window)).toHaveCount(0)
    const signedOut = parseProbe((await terminalProbe(window, commands)).text)
    expect(signedOut.bins).toEqual(signedIn.bins)
    expect(signedOut.commands).toEqual({ [boundCommand]: 'credential-absent', [unboundCommand]: 'credential-absent' })
  })

  test('sign-out warns while old access may still work, then Retry completes it', orgCase('withdrawal-pending'), async ({ acceptanceApp, window }, info) => {
    test.skip(process.platform === 'win32' || process.getuid?.() === 0, 'POSIX directory permissions must deny writes to the test process')
    await navigateToSettings(window)
    const card = settingsCard(window)
    await openLogin(acceptanceApp.app, () => signInOption(window).getByRole('button').click())
    expect((await control(acceptanceApp.profile, { action: 'confirm', method: 'phone' })).outcome).toBe('succeeded')
    await expect.poll(async () => (await readState(window)).boundTools[0]?.access).toBe('ready')
    const path = await acceptanceApp.app.evaluate(({ app }) => app.getPath('userData'))
    const slots = join(path, 'enterprise-identity')
    chmodSync(slots, 0o500)
    try {
      await signOutFromCard(window)
      await expect(card).toHaveAttribute('data-status', 'withdrawal-pending')
      await expect(card.getByText('Earlier access may still work until it expires.', { exact: true })).toBeVisible()
      await card.getByRole('button', { name: 'Tools that use this sign-in' }).click()
      await expect(card.getByTestId('org-account-tool')).toHaveAttribute('data-access', 'maybe-still-valid')
      await expect(card.getByText('No access', { exact: true })).toHaveCount(0)
      await expect(card.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
      await screenshotSizes(window, 'settings-card-withdrawal-pending', card, info)
    } finally {
      chmodSync(slots, 0o700)
    }
    await card.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(card).toHaveCount(0)
    await expect(signInOption(window)).toBeVisible()
    expect(await readState(window)).toMatchObject({ status: 'signed-out', boundTools: [{ access: 'none' }] })
  })
})

test.describe('silent organization restoration', () => {
  test.use({ productConfigPath: mockProduct, electronEnvironment: mockEnvironment(true) })

  test('restoration is pending and never warns before settling', orgCase('restore'), async ({ window }) => {
    await window.evaluate(() => {
      const selector = '[data-testid="org-sign-in-status"]'
      const seen = new Set<string>()
      const record = (mutations: MutationRecord[] = []) => {
        for (const mutation of mutations) {
          if (mutation.oldValue && (mutation.target as Element).matches(selector)) seen.add(mutation.oldValue)
        }
        const tone = document.querySelector(selector)?.getAttribute('data-tone')
        if (tone) seen.add(tone)
        document.documentElement.dataset.observedOrgTones = [...seen].join(',')
        if (tone === 'ok') observer.disconnect()
      }
      const observer = new MutationObserver(record)
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-tone'] })
      record()
    })
    await expect(indicator(window)).toHaveAttribute('data-tone', 'ok')
    await expect(window.locator('html')).toHaveAttribute('data-observed-org-tones', 'pending,ok')
    expect(await readState(window)).toMatchObject({ status: 'active' })
  })
})

test.describe('no organization configured', () => {
  test.use({ productConfigPath: unconfiguredProduct, startupObserver: fileURLToPath(new URL('../fixtures/org-request-count.cjs', import.meta.url)), firstLaunch: 'without-model' })

  test('unconfigured builds omit organization sign-in', orgCase('unconfigured'), async ({ acceptanceApp, window }) => {
    await expect(window.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Skip organization sign-in' })).toHaveCount(0)
    await window.getByRole('button', { name: 'Continue', exact: true }).click()
    await navigateToChat(window)
    await expect(indicator(window)).toHaveCount(0)
    await navigateToSettings(window)
    await expect(settingsCard(window)).toHaveCount(0)
    await expect(signInOption(window)).toHaveCount(0)
    expect(await acceptanceApp.app.evaluate(() => (globalThis as unknown as { orgIdentityRequests: number }).orgIdentityRequests)).toBe(0)
  })
})
