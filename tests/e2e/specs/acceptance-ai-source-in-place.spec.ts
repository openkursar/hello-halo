import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { HaloConfig } from '../../../src/renderer/types'
import { test, expect, aiSection, providerField, sourceCard, readProviderConfiguration, modelSettingsAcceptance } from '../fixtures/acceptance-model-settings'
import { navigateToSettings, navigateToChat, waitForHomePage, setTheme } from '../fixtures/helpers'

test.setTimeout(120000)
test.use({ seedOAuthAccount: true })

async function seedAccounts(page: Page, url: string, key: string) {
  const results = await page.evaluate(async ({ url, key }) => {
    const halo = (window as unknown as { halo: HaloAPI }).halo
    const results = []
    for (let index = 0; index < 24; index++) results.push(await halo.aiSourcesAddSource({
      id: `inline-account-${index}`, name: `Inline account ${index}`, provider: 'openai', authType: 'api-key',
      apiUrl: url, apiKey: key, model: 'gpt-4o', availableModels: [{ id: 'gpt-4o', name: 'gpt-4o' }],
    }))
    return results.map(result => ({ success: result.success, error: result.error }))
  }, { url, key })
  expect(results.every(result => result.success), JSON.stringify(results)).toBe(true)
  await page.reload()
  await waitForHomePage(page)
}

async function positionEntry(entry: Locator, top = 140) {
  await entry.evaluate((element, top) => {
    let parent = element.parentElement
    while (parent && parent.scrollHeight <= parent.clientHeight + 1) parent = parent.parentElement
    if (!parent) throw new Error('Settings must have a scroll container')
    parent.scrollTop += element.getBoundingClientRect().top - top
  }, top)
  await expect(entry).toBeInViewport()
}

// Waits for the entrance and opening scroll to settle, then checks the container moved only as far as needed to show its body.
// Settling also keeps Playwright from scrolling a still-animating control into view on the next click.
async function expectRevealed(container: Locator, top: number) {
  const result = await container.evaluate(async (element, top) => {
    const scroller = element.closest('main')!
    const entrances = element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    await Promise.allSettled(entrances.map(animation => animation.finished))
    await new Promise<void>(resolve => {
      let last = scroller.scrollTop
      let still = 0
      const tick = () => {
        still = scroller.scrollTop === last ? still + 1 : 0
        last = scroller.scrollTop
        if (still >= 10) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const view = scroller.getBoundingClientRect()
    const sticky = [...scroller.children].filter(child => getComputedStyle(child).position === 'sticky')
    const viewTop = Math.max(0, view.top, ...sticky.map(child => child.getBoundingClientRect().bottom))
    const viewBottom = Math.min(innerHeight, view.bottom)
    const bounds = element.getBoundingClientRect()
    const header = element.querySelector('[data-ai-source-header], [data-ai-group-header], [data-ai-panel-header]') ?? element
    const headerOffset = header.getBoundingClientRect().top - bounds.top
    const moved = top - bounds.top
    const room = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop + moved
    const wanted = Math.min(top + bounds.height + 16 - viewBottom, top + headerOffset - viewTop - 16)
    return { moved, expected: wanted < 1 ? 0 : Math.min(wanted, room), top, height: bounds.height, viewTop, viewBottom }
  }, top)
  expect(Math.abs(result.moved - result.expected), JSON.stringify(result)).toBeLessThanOrEqual(2)
}

async function expectUnobscuredHeader(container: Locator) {
  const result = await container.evaluate(element => {
    const scroller = element.closest('main')!
    const sticky = [...scroller.children].filter(child => getComputedStyle(child).position === 'sticky')
    const header = element.querySelector<HTMLElement>('[data-ai-source-header], [data-ai-group-header], [data-ai-panel-header]')!
    const title = header.querySelector<HTMLElement>('[title], h3, .font-medium')!
    const bounds = title.getBoundingClientRect()
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
    return {
      width: innerWidth,
      stickyCount: sticky.length,
      stickyBottom: Math.max(0, ...sticky.map(child => child.getBoundingClientRect().bottom)),
      headerTop: header.getBoundingClientRect().top,
      title: title.textContent,
      titleHit: hit === title || !!hit && title.contains(hit),
    }
  })
  if (result.width >= 640) return
  expect(result.stickyCount, JSON.stringify(result)).toBeGreaterThan(0)
  expect(result.headerTop, JSON.stringify(result)).toBeGreaterThanOrEqual(result.stickyBottom)
  expect(result.titleHit, JSON.stringify(result)).toBe(true)
  await test.info().attach('unobscured-inline-header', { body: JSON.stringify(result), contentType: 'application/json' })
}

async function openInPlace(page: Page, container: Locator, entry: Locator, title: string) {
  await positionEntry(container)
  const node = await container.elementHandle()
  const top = await container.evaluate(element => element.getBoundingClientRect().top)
  const preceding = await container.evaluateHandle(element => element.previousElementSibling)
  const precedingTop = await preceding.evaluate(element => element?.getBoundingClientRect().top)
  await entry.click()
  const editor = container.getByRole('region', { name: title, exact: true })
  await expect(editor).toBeVisible()
  await expectRevealed(container, top)
  await expectUnobscuredHeader(container)
  expect(await container.evaluate((element, node) => element === node, node)).toBe(true)
  const currentTop = await container.evaluate(element => element.getBoundingClientRect().top)
  if (precedingTop !== undefined) expect(Math.abs(currentTop - (await preceding.evaluate(element => element?.getBoundingClientRect().top))! - (top - precedingTop))).toBeLessThanOrEqual(1)
  await expect(editor.locator('input, select, textarea, button').first()).toBeInViewport()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  return { editor, top }
}

async function cancelEditor(container: Locator, editor: Locator, entry: Locator, top: number) {
  await positionEntry(container, top)
  await editor.getByRole('button', { name: 'Cancel', exact: true }).evaluate((button: HTMLButtonElement) => button.click())
  await expect(editor).toHaveCount(0)
  await expect(entry).toBeFocused()
  expect(Math.abs(await container.evaluate(element => element.getBoundingClientRect().top) - top)).toBeLessThanOrEqual(1)
}

async function installPreset(app: import('@playwright/test').ElectronApplication, url: string) {
  await app.evaluate(({ ipcMain }, url) => {
    ipcMain.removeHandler('auth:get-providers')
    ipcMain.handle('auth:get-providers', () => ({ success: true, data: [
      { type: 'local-preset', displayName: 'Local preset', description: 'Isolated API account', icon: 'Key', iconBgColor: '', recommended: false, enabled: true,
        preset: { baseUrl: url, apiType: 'chat_completions', modelsPath: '/models', fallbackModels: [{ id: 'gpt-4o', name: 'gpt-4o' }], docs: { url: 'https://example.invalid/docs', label: 'Documentation' } } },
      { type: 'chatgpt', displayName: 'ChatGPT', description: 'Isolated login', icon: 'Key', iconBgColor: '', recommended: false, enabled: true, builtin: true },
    ] }))
  }, url)
}

function uiAcceptance(caseId: string, variant: Record<string, string> = {}) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'ui', mode: 'none', variant }) } }
}

for (const width of [1280, 390]) {
  test(`account editors keep their card and drafts at ${width}px`, modelSettingsAcceptance('models.accounts.in-place', 'none', { width: String(width) }), async ({ window, managementApp, providerGateway }) => {
    await window.setViewportSize({ width, height: 844 })
    await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
    await navigateToSettings(window)
    const original = readProviderConfiguration(managementApp.profile)
    expect(original.sources).toHaveLength(25)
    const addRow = window.locator('[data-ai-add-row]')
    const add = addRow.getByRole('button', { name: 'Add AI Provider', exact: true })
    const opened = await openInPlace(window, addRow, add, 'Add AI Provider')
    await expect(addRow.getByRole('heading', { name: 'Add AI Provider', exact: true }).first()).toBeInViewport()
    await providerField(window, 'Display Name').fill('Discarded provider draft')
    await opened.editor.getByRole('button', { name: /^O OpenAI/ }).click()
    await opened.editor.getByPlaceholder('Search providers...', { exact: true }).fill('DeepSeek')
    await window.keyboard.press('Escape')
    await expect(opened.editor.getByPlaceholder('Search providers...', { exact: true })).toHaveCount(0)
    await window.keyboard.press('Escape')
    await expect(opened.editor).toBeVisible()
    await expect(providerField(window, 'Display Name')).toHaveValue('Discarded provider draft')
    await cancelEditor(addRow, opened.editor, add, opened.top)
    for (const name of ['Inline account 23', 'Inline OAuth account']) {
      const card = sourceCard(window, name)
      await card.locator('[data-ai-source-header]').click()
      const edit = card.getByRole('button', { name: 'Edit', exact: true })
      const { editor, top } = await openInPlace(window, card, edit, name.includes('OAuth') ? 'Edit Account' : 'Edit Provider')
      await expect(card.locator('[data-ai-source-header]').getByText(name, { exact: true })).toBeInViewport()
      await providerField(window, 'Display Name').fill('Discarded account draft')
      await window.keyboard.press('Escape')
      await expect(editor).toBeVisible()
      await cancelEditor(card, editor, edit, top)
    }
    expect(readProviderConfiguration(managementApp.profile)).toEqual(original)
    expect(providerGateway.requests).toEqual([])
    const card = sourceCard(window, 'Inline account 23')
    const edit = card.getByRole('button', { name: 'Edit', exact: true })
    if (!await edit.isVisible()) await card.locator('[data-ai-source-header]').click()
    await openInPlace(window, card, edit, 'Edit Provider')
    const editor = card.getByRole('region', { name: 'Edit Provider', exact: true })
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await expect(card.locator('[data-ai-source-header]')).toBeInViewport()
    await expect(edit).toBeFocused()
    expect(readProviderConfiguration(managementApp.profile)).toEqual(original)
  })

  test(`switching from a partially visible upper editor never moves the target at ${width}px`, modelSettingsAcceptance('models.accounts.in-place-switch', 'none', { width: String(width) }), async ({ window, managementApp, providerGateway }) => {
    await window.setViewportSize({ width, height: 844 })
    await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
    await navigateToSettings(window)
    const original = readProviderConfiguration(managementApp.profile)
    const upper = sourceCard(window, 'Inline account 20')
    const target = sourceCard(window, 'Inline account 21')
    await upper.locator('[data-ai-source-header]').click()
    await openInPlace(window, upper, upper.getByRole('button', { name: 'Edit', exact: true }), 'Edit Provider')
    await providerField(window, 'Display Name').fill('Never saved upper draft')
    await target.locator('[data-ai-source-header]').click()
    await positionEntry(target, 360)
    const bounds = await upper.boundingBox()
    expect(bounds!.y).toBeLessThan(0)
    expect(bounds!.y + bounds!.height).toBeGreaterThan(0)
    await expect(target.getByRole('button', { name: 'Edit', exact: true })).toBeInViewport()
    const samples = await target.evaluateHandle(element => {
      const scroller = element.closest('main')!
      const state = { node: element, top: element.getBoundingClientRect().top, samples: [] as Array<{ top: number; scroll: number }>, active: true }
      const sample = () => { state.samples.push({ top: element.getBoundingClientRect().top, scroll: scroller.scrollTop }); if (state.active) requestAnimationFrame(sample) }
      requestAnimationFrame(sample)
      return state
    })
    const screencast = await window.context().newCDPSession(window)
    const frames: Buffer[] = []
    const acknowledgements: Promise<unknown>[] = []
    screencast.on('Page.screencastFrame', event => {
      frames.push(Buffer.from(event.data, 'base64'))
      acknowledgements.push(screencast.send('Page.screencastFrameAck', { sessionId: event.sessionId }))
    })
    await window.screenshot({ path: test.info().outputPath(`switch-before-${width}.png`) })
    await screencast.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 })
    try {
      await target.getByRole('button', { name: 'Edit', exact: true }).click()
      await expect(target.getByRole('region', { name: 'Edit Provider', exact: true })).toBeVisible()
      await expectRevealed(target, 360)
      await window.screenshot({ path: test.info().outputPath(`switch-after-${width}.png`) })
    } finally {
      await screencast.send('Page.stopScreencast')
      await Promise.all(acknowledgements)
      await screencast.detach()
      for (const [index, frame] of frames.entries()) await test.info().attach(`switch-${width}-frame-${String(index).padStart(4, '0')}.jpeg`, { body: frame, contentType: 'image/jpeg' })
    }
    expect(frames.length, 'The switching screencast must contain visual frames').toBeGreaterThan(0)
    const result = await samples.evaluate(state => { state.active = false; return { connected: state.node.isConnected, top: state.top, samples: state.samples } })
    expect(result.connected).toBe(true)
    expect(result.samples.length).toBeGreaterThan(0)
    expect(Math.abs(result.samples[0].top - result.top), JSON.stringify(result)).toBeLessThanOrEqual(1)
    const steps = result.samples.slice(1).map((current, index) => ({ top: current.top - result.samples[index].top, scroll: current.scroll - result.samples[index].scroll }))
    expect(steps.every(step => step.top <= 1 && (Math.abs(step.top) <= 1 || Math.abs(step.top + step.scroll) <= 1)), JSON.stringify(result)).toBe(true)
    await test.info().attach('target-position-frames', { body: JSON.stringify(result), contentType: 'application/json' })
    await expect(upper.getByRole('region')).toHaveCount(0)
    expect(readProviderConfiguration(managementApp.profile)).toEqual(original)
    expect(providerGateway.requests).toEqual([])
  })

  test(`a bottom-edge edit scrolls up just enough to reveal its editor at ${width}px`, modelSettingsAcceptance('models.accounts.in-place-bottom', 'none', { width: String(width) }), async ({ window, providerGateway }) => {
    await window.setViewportSize({ width, height: 844 })
    await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
    await navigateToSettings(window)
    const card = sourceCard(window, 'Inline account 23')
    await card.locator('[data-ai-source-header]').click()
    const edit = card.getByRole('button', { name: 'Edit', exact: true })
    await positionEntry(edit, 780)
    const node = await card.elementHandle()
    const top = await card.evaluate(element => element.getBoundingClientRect().top)
    const samples = await card.evaluateHandle(element => {
      const state = { tops: [] as number[], active: true }
      const sample = () => { state.tops.push(element.getBoundingClientRect().top); if (state.active) requestAnimationFrame(sample) }
      requestAnimationFrame(sample)
      return state
    })
    await edit.click()
    const editor = card.getByRole('region', { name: 'Edit Provider', exact: true })
    await expect(editor).toBeVisible()
    await expectRevealed(card, top)
    const tops = await samples.evaluate(state => { state.active = false; return state.tops })
    expect(await card.evaluate((element, node) => element === node, node)).toBe(true)
    expect(top - await card.evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThan(1)
    expect(tops.slice(1).every((current, index) => current <= tops[index] + 1), JSON.stringify(tops)).toBe(true)
    await expect(card.locator('[data-ai-source-header]')).toBeInViewport()
    await expect(editor.locator('input, select, textarea, button').first()).toBeInViewport()
  })

  test(`new and edited accounts retain selection semantics at ${width}px`, modelSettingsAcceptance('models.accounts.in-place-save', 'none', { width: String(width) }), async ({ window, managementApp, providerGateway }) => {
    await window.setViewportSize({ width, height: 844 })
    await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
    await navigateToSettings(window)
    const row = window.locator('[data-ai-add-row]')
    const { editor } = await openInPlace(window, row, row.getByRole('button', { name: 'Add AI Provider', exact: true }), 'Add AI Provider')
    await providerField(window, 'Display Name').fill('Visible new account')
    await providerField(window, 'API URL').fill(providerGateway.url('primary'))
    await providerField(window, 'API Key').fill(providerGateway.key('primary'))
    await aiSection(window).getByLabel('Use custom model ID', { exact: true }).check()
    await aiSection(window).getByPlaceholder('Enter model ID', { exact: true }).fill('gpt-4o')
    await aiSection(window).getByRole('button', { name: 'Apply', exact: true }).click()
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(sourceCard(window, 'Visible new account')).toBeInViewport()
    const saved = readProviderConfiguration(managementApp.profile)
    const account = saved.sources.find(source => source.name === 'Visible new account')!
    const card = window.locator(`[data-ai-source-id="${account.id}"]`)
    await expect(card).toBeFocused()
    await expect(card).toHaveClass(/pulse-highlight/)
    expect(saved.currentId).toBe(account.id)
    if (!await card.getByRole('button', { name: 'Edit', exact: true }).isVisible()) await card.locator('[data-ai-source-header]').click()
    const edit = card.getByRole('button', { name: 'Edit', exact: true })
    const opened = await openInPlace(window, card, edit, 'Edit Provider')
    await providerField(window, 'Display Name').fill('Updated visible account')
    await opened.editor.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(edit).toBeFocused()
    await expect(card).toBeInViewport()
    const updated = readProviderConfiguration(managementApp.profile)
    expect(updated.currentId).toBe(account.id)
    expect(updated.sources.find(source => source.id === account.id)?.name).toBe('Updated visible account')
    const oauth = sourceCard(window, 'Inline OAuth account')
    await oauth.locator('[data-ai-source-header]').click()
    const oauthOpened = await openInPlace(window, oauth, oauth.getByRole('button', { name: 'Edit', exact: true }), 'Edit Account')
    await providerField(window, 'Display Name').fill('Updated OAuth account')
    await oauthOpened.editor.getByRole('button', { name: 'Save', exact: true }).click()
    const renamedOAuth = window.locator('[data-ai-source-id="inline-oauth"]')
    await expect(renamedOAuth.getByRole('region')).toHaveCount(0)
    await expect(renamedOAuth.getByRole('button', { name: 'Edit', exact: true })).toBeFocused()
    const afterOAuth = readProviderConfiguration(managementApp.profile)
    expect(afterOAuth.currentId).toBe(account.id)
    const persistedOAuth = afterOAuth.sources.find(source => source.id === 'inline-oauth')!
    const expectedOAuth = updated.sources.find(source => source.id === 'inline-oauth')!
    expect({ ...persistedOAuth, updatedAt: expectedOAuth.updatedAt }).toEqual({ ...expectedOAuth, name: 'Updated OAuth account', modelOverrides: {} })
    expect(Date.parse(persistedOAuth.updatedAt)).toBeGreaterThanOrEqual(Date.parse(expectedOAuth.updatedAt))
  })

  test(`delete confirmation cancels safely and restores adjacent focus at ${width}px`, modelSettingsAcceptance('models.accounts.in-place-delete', 'none', { width: String(width) }), async ({ window, managementApp, providerGateway }) => {
    await window.setViewportSize({ width, height: 844 })
    await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
    await navigateToSettings(window)
    const before = readProviderConfiguration(managementApp.profile)
    const card = sourceCard(window, 'Inline account 22')
    await card.locator('[data-ai-source-header]').click()
    const remove = card.getByRole('button', { name: 'Delete', exact: true })
    await positionEntry(card)
    for (const action of ['Escape', 'Cancel']) {
      await remove.click()
      const confirm = window.getByRole('alertdialog', { name: 'Delete this account?', exact: true })
      await expect(confirm).toContainText('Inline account 22')
      if (action === 'Escape') await window.keyboard.press('Escape')
      else await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(confirm).toHaveCount(0)
      expect(readProviderConfiguration(managementApp.profile)).toEqual(before)
    }
    await remove.click()
    await window.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(card).toHaveCount(0)
    await expect(sourceCard(window, 'Inline account 23')).toBeFocused()
    expect(readProviderConfiguration(managementApp.profile).sources.some(source => source.id === 'inline-account-22')).toBe(false)
  })

  test(`group creation and editing remain in place at ${width}px`, modelSettingsAcceptance('models.groups.in-place', 'none', { width: String(width) }), async ({ window, managementApp, providerGateway }) => {
    await window.setViewportSize({ width, height: 844 })
    await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
    await navigateToSettings(window)
    const before = readProviderConfiguration(managementApp.profile)
    const row = window.locator('[data-ai-add-row]')
    await positionEntry(row)
    const top = await row.evaluate(element => element.getBoundingClientRect().top)
    await row.getByRole('button', { name: 'More ways to add', exact: true }).click()
    await window.getByRole('button', { name: /Create Load-Balancing Group/ }).click()
    const editor = row.getByRole('region', { name: 'Create Load-Balancing Group', exact: true })
    await expect(editor).toBeVisible()
    await expectRevealed(row, top)
    await expectUnobscuredHeader(row)
    await expect(editor.locator('input').first()).toBeInViewport()
    await editor.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(editor.getByRole('alert')).toBeVisible()
    expect(readProviderConfiguration(managementApp.profile).groups ?? []).toEqual([])
    const addModel = editor.getByRole('button', { name: 'Add model', exact: true })
    await addModel.click()
    await editor.getByPlaceholder('Search accounts and models', { exact: true }).fill('Inline account')
    await window.keyboard.press('Escape')
    await expect(editor.getByPlaceholder('Search accounts and models', { exact: true })).toHaveCount(0)
    await expect(addModel).toBeFocused()
    await editor.getByRole('button', { name: 'Quick add from accounts', exact: true }).click()
    await editor.getByLabel('Name', { exact: true }).fill('Visible inline group')
    await editor.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(sourceCard(window, 'Visible inline group')).toBeInViewport()
    const saved = readProviderConfiguration(managementApp.profile)
    const card = window.locator(`[data-ai-group-id="${saved.groups![0].id}"]`)
    await expect(card).toBeFocused()
    await expect(card).toHaveClass(/pulse-highlight/)
    expect(saved.currentId).toBe(before.currentId)
    expect(saved.currentGroupId ?? null).toBe(before.currentGroupId ?? null)
    const edit = card.getByRole('button', { name: 'Edit', exact: true })
    if (!await edit.isVisible()) await card.locator('[data-ai-group-header]').click()
    const opened = await openInPlace(window, card, edit, 'Edit Load-Balancing Group')
    await opened.editor.getByLabel('Name', { exact: true }).fill('Discarded group name')
    await window.keyboard.press('Escape')
    await expect(opened.editor).toBeVisible()
    await cancelEditor(card, opened.editor, edit, opened.top)
    expect(readProviderConfiguration(managementApp.profile).groups).toEqual(saved.groups)
    const updatedEditor = await openInPlace(window, card, edit, 'Edit Load-Balancing Group')
    await updatedEditor.editor.getByLabel('Name', { exact: true }).fill('Updated inline group')
    await updatedEditor.editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(edit).toBeFocused()
    await expect(card).toBeInViewport()
    const updated = readProviderConfiguration(managementApp.profile)
    expect(updated.groups?.[0]).toMatchObject({ id: saved.groups![0].id, name: 'Updated inline group', members: saved.groups![0].members })
    expect(updated.currentId).toBe(before.currentId)
    expect(updated.currentGroupId ?? null).toBe(before.currentGroupId ?? null)
  })
}

for (const flow of ['device', 'redirect']) {
  test(`OAuth ${flow} stays in its row and retries local failure`, uiAcceptance('models.accounts.in-place-login', { flow }), async ({ window, managementApp, providerGateway }) => {
    await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
    await managementApp.app.evaluate(({ ipcMain }, flow) => {
      const state = { calls: 0, cancelled: [] as Array<{ provider: string; loginId: string }> }
      ;(globalThis as unknown as { inlineLoginState: typeof state }).inlineLoginState = state
      for (const channel of ['auth:start-login', 'auth:complete-login', 'auth:cancel-login']) ipcMain.removeHandler(channel)
      ipcMain.handle('auth:start-login', () => {
        state.calls++
        if (state.calls === 1) return { success: false, error: 'Synthetic login failure' }
        return { success: true, data: flow === 'device'
          ? { loginId: 'isolated-device-login', state: 'isolated-state', userCode: 'TEST-CODE', verificationUri: 'https://example.invalid/device' }
          : { loginId: 'isolated-redirect-login', state: 'isolated-state', redirectUri: 'http://127.0.0.1:1/callback', loginUrl: 'https://example.invalid/authorize' } }
      })
      ipcMain.handle('auth:complete-login', () => new Promise(() => {}))
      ipcMain.handle('auth:cancel-login', (_event, provider: string, loginId: string) => { state.cancelled.push({ provider, loginId }); return { success: true } })
    }, flow)
    await navigateToSettings(window)
    const original = readProviderConfiguration(managementApp.profile)
    const row = window.locator('[data-ai-provider-row="chatgpt"]')
    const entry = row.getByRole('button').first()
    await positionEntry(row)
    const top = await row.evaluate(element => element.getBoundingClientRect().top)
    await entry.click()
    const panel = row.locator('[data-ai-login-panel]')
    await expect(panel).toContainText('Synthetic login failure')
    await expectRevealed(row, top)
    const retryTop = await row.evaluate(element => element.getBoundingClientRect().top)
    await panel.getByRole('button', { name: 'Try again', exact: true }).click()
    if (flow === 'device') await expect(panel.getByText('TEST-CODE', { exact: true })).toBeVisible()
    else await expect(panel.getByPlaceholder('Paste authorization code here', { exact: true })).toBeVisible()
    await expectRevealed(row, retryTop)
    await window.keyboard.press('Escape')
    await expect(panel).toBeVisible()
    const account = sourceCard(window, 'Inline account 23')
    await account.locator('[data-ai-source-header]').click()
    const accountEdit = account.getByRole('button', { name: 'Edit', exact: true })
    const editing = await openInPlace(window, account, accountEdit, 'Edit Provider')
    await expect(panel).toBeAttached()
    expect(await managementApp.app.evaluate(() => (globalThis as unknown as { inlineLoginState: { cancelled: unknown[] } }).inlineLoginState.cancelled)).toEqual([])
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(editing.editor).toBeVisible()
    await entry.click()
    await expect(panel).toBeVisible()
    await expect(editing.editor).toBeVisible()
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await expect(entry).toBeFocused()
    await cancelEditor(account, editing.editor, accountEdit, editing.top)
    expect(await managementApp.app.evaluate(() => (globalThis as unknown as { inlineLoginState: { cancelled: unknown[] } }).inlineLoginState.cancelled)).toEqual([{ provider: 'chatgpt', loginId: `isolated-${flow}-login` }, { provider: 'chatgpt', loginId: `isolated-${flow}-login` }])
    expect(readProviderConfiguration(managementApp.profile)).toEqual(original)
    expect(providerGateway.requests).toEqual([])
  })
}

test('a refused or pending save keeps the draft and gates other entry points', uiAcceptance('models.accounts.in-place-failure'), async ({ window, managementApp, providerGateway }) => {
  await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
  await navigateToSettings(window)
  const original = readProviderConfiguration(managementApp.profile)
  const card = sourceCard(window, 'Inline account 23')
  await card.locator('[data-ai-source-header]').click()
  const edit = card.getByRole('button', { name: 'Edit', exact: true })
  const { editor, top } = await openInPlace(window, card, edit, 'Edit Provider')
  await providerField(window, 'Display Name').fill('Retained after save refusal')
  await managementApp.app.evaluate(({ ipcMain }) => {
    const gate = { calls: 0, finish: null as null | (() => void) }
    ;(globalThis as unknown as { inlineSaveGate: typeof gate }).inlineSaveGate = gate
    ipcMain.removeHandler('ai-sources:update-source')
    ipcMain.handle('ai-sources:update-source', async () => {
      gate.calls++
      if (gate.calls === 1) return { success: false, error: 'Synthetic refused save' }
      return new Promise(resolve => { gate.finish = () => resolve({ success: false, error: 'Synthetic deferred refusal' }) })
    })
  })
  await editor.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(editor.getByRole('alert')).toHaveText('Save failed')
  await expect(providerField(window, 'Display Name')).toHaveValue('Retained after save refusal')
  await editor.getByRole('button', { name: 'Update', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click() })
  await expect(editor).toHaveAttribute('aria-busy', 'true')
  await expect(editor.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  await window.keyboard.press('Escape')
  await expect(editor).toBeVisible()
  expect(await managementApp.app.evaluate(() => (globalThis as unknown as { inlineSaveGate: { calls: number } }).inlineSaveGate.calls)).toBe(2)
  await managementApp.app.evaluate(() => (globalThis as unknown as { inlineSaveGate: { finish: () => void } }).inlineSaveGate.finish())
  await expect(editor.getByRole('alert')).toHaveText('Save failed')
  await expect(providerField(window, 'Display Name')).toHaveValue('Retained after save refusal')
  expect(readProviderConfiguration(managementApp.profile)).toEqual(original)
  await cancelEditor(card, editor, edit, top)

  const oauth = sourceCard(window, 'Inline OAuth account')
  await oauth.locator('[data-ai-source-header]').click()
  const oauthEdit = oauth.getByRole('button', { name: 'Edit', exact: true })
  const opened = await openInPlace(window, oauth, oauthEdit, 'Edit Account')
  await providerField(window, 'Display Name').fill('Retained OAuth draft')
  await opened.editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(opened.editor).toHaveAttribute('aria-busy', 'true')
  await expect(opened.editor.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  await managementApp.app.evaluate(() => (globalThis as unknown as { inlineSaveGate: { finish: () => void } }).inlineSaveGate.finish())
  await expect(opened.editor.getByRole('alert')).toHaveText('Synthetic deferred refusal')
  await expect(providerField(window, 'Display Name')).toHaveValue('Retained OAuth draft')
  await expect(opened.editor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  expect(await managementApp.app.evaluate(() => (globalThis as unknown as { inlineSaveGate: { calls: number } }).inlineSaveGate.calls)).toBe(3)
  expect(readProviderConfiguration(managementApp.profile)).toEqual(original)
  await test.info().attach('oauth-save-failure-reason', { body: JSON.stringify({ reason: await opened.editor.getByRole('alert').innerText(), draft: await providerField(window, 'Display Name').inputValue() }), contentType: 'application/json' })
  await cancelEditor(oauth, opened.editor, oauthEdit, opened.top)
})

test('the chat model card opens its group editor in view', modelSettingsAcceptance('models.groups.in-place-external', 'none'), async ({ window, managementApp, providerGateway }) => {
  await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
  const created = await window.evaluate(async () => (window as unknown as { halo: HaloAPI }).halo.aiGroupsCreate({ name: 'Picker inline group', members: [{ sourceId: 'inline-account-0', modelId: 'gpt-4o' }] }))
  expect(created.success).toBe(true)
  const selected = await window.evaluate(async groupId => (window as unknown as { halo: HaloAPI }).halo.aiSourcesSwitchSource(groupId), created.data!.groupId)
  expect(selected.success).toBe(true)
  await window.reload()
  await waitForHomePage(window)
  await navigateToChat(window)
  await window.getByRole('button', { name: 'gpt-4o', exact: true }).click()
  await window.getByTitle('Switch model', { exact: true }).click()
  const choice = window.getByTitle('Picker inline group · Auto', { exact: true })
  if (await choice.getAttribute('aria-expanded') !== 'true') await choice.click()
  await window.getByRole('button', { name: /Choose automatically/ }).click()
  await window.getByRole('button', { name: 'Picker inline group · Auto', exact: true }).click()
  await window.getByRole('button', { name: 'Edit this group', exact: true }).click()
  const card = sourceCard(window, 'Picker inline group')
  await expect(card.getByRole('region', { name: 'Edit Load-Balancing Group', exact: true })).toBeInViewport()
  await expect(card.locator('[data-ai-group-header]')).toBeInViewport()
  expect(readProviderConfiguration(managementApp.profile).currentGroupId).toBe(created.data!.groupId)
})

test('a partial account save retries the same identity without adding twice', uiAcceptance('models.accounts.in-place-partial-save'), async ({ window, managementApp, providerGateway }) => {
  await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
  await managementApp.app.evaluate(({ ipcMain }) => {
    const gate = { calls: 0 }
    ;(globalThis as unknown as { inlineSwitchGate: typeof gate }).inlineSwitchGate = gate
    ipcMain.removeHandler('ai-sources:switch-source')
    ipcMain.handle('ai-sources:switch-source', () => { gate.calls++; return { success: false, error: 'Synthetic selection refusal' } })
  })
  await navigateToSettings(window)
  const row = window.locator('[data-ai-add-row]')
  const { editor } = await openInPlace(window, row, row.getByRole('button', { name: 'Add AI Provider', exact: true }), 'Add AI Provider')
  await providerField(window, 'Display Name').fill('Partial save account')
  await providerField(window, 'API URL').fill(providerGateway.url('primary'))
  await providerField(window, 'API Key').fill(providerGateway.key('primary'))
  await editor.getByLabel('Use custom model ID', { exact: true }).check()
  await editor.getByPlaceholder('Enter model ID', { exact: true }).fill('gpt-4o')
  await editor.getByRole('button', { name: 'Apply', exact: true }).click()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor.getByRole('alert')).toHaveText('Save failed')
  const first = readProviderConfiguration(managementApp.profile).sources.filter(source => source.name === 'Partial save account')
  expect(first).toHaveLength(1)
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => managementApp.app.evaluate(() => (globalThis as unknown as { inlineSwitchGate: { calls: number } }).inlineSwitchGate.calls)).toBe(2)
  await expect(editor.getByRole('alert')).toHaveText('Save failed')
  await expect(providerField(window, 'Display Name')).toHaveValue('Partial save account')
  expect(readProviderConfiguration(managementApp.profile).sources.filter(source => source.name === 'Partial save account')).toMatchObject([{ id: first[0].id }])
})

for (const width of [1280, 390]) {
  test(`preset row adds locally and reveals its account at ${width}px`, uiAcceptance('models.accounts.in-place-preset', { width: String(width) }), async ({ window, managementApp, providerGateway }) => {
    await window.setViewportSize({ width, height: 844 })
    await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
    await installPreset(managementApp.app, providerGateway.url('primary'))
    await navigateToSettings(window)
    const row = window.locator('[data-ai-provider-row="local-preset"]')
    const entry = row.getByRole('button').first()
    const { editor, top } = await openInPlace(window, row, entry, 'Local preset')
    await expect(editor.getByText('Documentation', { exact: true })).toBeVisible()
    await cancelEditor(row, editor, entry, top)
    const reopened = await openInPlace(window, row, entry, 'Local preset')
    await providerField(window, 'API Key').fill(providerGateway.key('primary'))
    await reopened.editor.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(row).toHaveCount(0)
    const card = sourceCard(window, 'Local preset')
    await expect(card).toBeInViewport()
    await expect(card).toBeFocused()
    await expect(card).toHaveClass(/pulse-highlight/)
    const saved = readProviderConfiguration(managementApp.profile)
    expect(saved.currentId).toBe(saved.sources.find(source => source.name === 'Local preset')!.id)
    expect(providerGateway.requests.every(request => request.endpoint === 'primary')).toBe(true)
  })
}

for (const width of [1280, 390]) for (const theme of ['dark', 'light'] as const) {
  test(`inline states in ${theme} at ${width}px`, uiAcceptance('models.accounts.in-place-visual', { width: String(width), theme }), async ({ window, managementApp, providerGateway }) => {
    await window.setViewportSize({ width, height: 844 })
    await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
    await setTheme(window, theme)
    await installPreset(managementApp.app, providerGateway.url('primary'))
    await managementApp.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('auth:start-login')
      ipcMain.removeHandler('auth:complete-login')
      ipcMain.removeHandler('auth:cancel-login')
      ipcMain.handle('auth:start-login', () => ({ success: true, data: { loginId: 'visual-device', state: 'visual-state', userCode: 'TEST-CODE', verificationUri: 'https://example.invalid/device' } }))
      ipcMain.handle('auth:complete-login', () => new Promise(() => {}))
      ipcMain.handle('auth:cancel-login', () => ({ success: true }))
    })
    await navigateToSettings(window)
    await setTheme(window, theme)
    const capture = async (state: string) => {
      await window.evaluate(async () => {
        const finite = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        await Promise.allSettled(finite.map(animation => animation.finished))
      })
      expect(await window.locator('html').evaluate(element => element.classList.contains('light'))).toBe(theme === 'light')
      expect(await aiSection(window).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      await window.screenshot({ path: test.info().outputPath(`${state}-${theme}-${width}.png`) })
    }
    const card = sourceCard(window, 'Inline account 23')
    await card.locator('[data-ai-source-header]').click()
    const edit = card.getByRole('button', { name: 'Edit', exact: true })
    const opened = await openInPlace(window, card, edit, 'Edit Provider')
    await capture('edit')
    await cancelEditor(card, opened.editor, edit, opened.top)
    const row = window.locator('[data-ai-add-row]')
    const add = row.getByRole('button', { name: 'Add AI Provider', exact: true })
    const addition = await openInPlace(window, row, add, 'Add AI Provider')
    await capture('add')
    await cancelEditor(row, addition.editor, add, addition.top)
    const preset = window.locator('[data-ai-provider-row="local-preset"]')
    const presetEntry = preset.getByRole('button').first()
    const presetOpened = await openInPlace(window, preset, presetEntry, 'Local preset')
    await capture('preset')
    await cancelEditor(preset, presetOpened.editor, presetEntry, presetOpened.top)
    await positionEntry(row)
    const groupTop = await row.evaluate(element => element.getBoundingClientRect().top)
    await row.getByRole('button', { name: 'More ways to add', exact: true }).click()
    await window.getByRole('button', { name: /Create Load-Balancing Group/ }).click()
    await expect(row.getByRole('region', { name: 'Create Load-Balancing Group', exact: true })).toBeVisible()
    await expectRevealed(row, groupTop)
    await expectUnobscuredHeader(row)
    await capture('group-create')
    await row.getByRole('button', { name: 'Cancel', exact: true }).click()
    const loginRow = window.locator('[data-ai-provider-row="chatgpt"]')
    await positionEntry(loginRow)
    await loginRow.getByRole('button').first().click()
    await expect(loginRow.getByText('TEST-CODE', { exact: true })).toBeVisible()
    await capture('device')
    await loginRow.getByRole('button', { name: 'Cancel', exact: true }).click()
    await positionEntry(card)
    await card.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(window.getByRole('alertdialog', { name: 'Delete this account?', exact: true })).toBeVisible()
    await capture('delete')
    await window.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  })
}

test('coarse-pointer editing focuses the region without focusing an input', modelSettingsAcceptance('models.accounts.in-place-touch', 'none'), async ({ window, providerGateway }) => {
  await window.setViewportSize({ width: 390, height: 844 })
  await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
  await navigateToSettings(window)
  const session = await window.context().newCDPSession(window)
  try {
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    expect(await window.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    const row = window.locator('[data-ai-add-row]')
    const { editor } = await openInPlace(window, row, row.getByRole('button', { name: 'Add AI Provider', exact: true }), 'Add AI Provider')
    await expect(editor).toBeFocused()
    expect(await editor.locator('input').evaluateAll(inputs => inputs.some(input => input === document.activeElement))).toBe(false)
  } finally {
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await session.detach()
  }
})

test.describe('without available accounts', () => {
  test.use({ seedOAuthAccount: false })
  test('group creation switches to adding a provider in the same row', modelSettingsAcceptance('models.groups.in-place-add-provider', 'none'), async ({ window, managementApp }) => {
    await navigateToSettings(window)
    expect(readProviderConfiguration(managementApp.profile).sources).toHaveLength(0)
    const row = window.locator('[data-ai-add-row]')
    await positionEntry(row)
    const node = await row.elementHandle()
    const initialTop = await row.evaluate(element => element.getBoundingClientRect().top)
    await row.getByRole('button', { name: 'More ways to add', exact: true }).click()
    await window.getByRole('button', { name: /Create Load-Balancing Group/ }).click()
    const group = row.getByRole('region', { name: 'Create Load-Balancing Group', exact: true })
    await expect(group).toBeVisible()
    await expectRevealed(row, initialTop)
    const top = await row.evaluate(element => element.getBoundingClientRect().top)
    await group.getByRole('button', { name: 'Add AI Provider', exact: true }).click()
    await expect(group).toHaveCount(0)
    await expect(row.getByRole('region', { name: 'Add AI Provider', exact: true })).toBeVisible()
    expect(await row.evaluate((element, node) => element === node, node)).toBe(true)
    expect(Math.abs(await row.evaluate(element => element.getBoundingClientRect().top) - top)).toBeLessThanOrEqual(1)
    expect(readProviderConfiguration(managementApp.profile).sources).toHaveLength(0)
  })
})

test('a partially saved preset retains its row and retries the same identity', uiAcceptance('models.accounts.in-place-preset-partial'), async ({ window, managementApp, providerGateway }) => {
  await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
  await installPreset(managementApp.app, providerGateway.url('primary'))
  await managementApp.app.evaluate(({ ipcMain }) => {
    const state = { calls: 0 }
    ;(globalThis as unknown as { presetSwitchState: typeof state }).presetSwitchState = state
    ipcMain.removeHandler('ai-sources:switch-source')
    ipcMain.handle('ai-sources:switch-source', () => { state.calls++; return { success: false, error: 'Synthetic preset selection refusal' } })
  })
  await navigateToSettings(window)
  const row = window.locator('[data-ai-provider-row="local-preset"]')
  const node = await row.elementHandle()
  const { editor } = await openInPlace(window, row, row.getByRole('button').first(), 'Local preset')
  await providerField(window, 'API Key').fill(providerGateway.key('primary'))
  await editor.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(editor.getByRole('alert')).toHaveText('Save failed')
  const first = readProviderConfiguration(managementApp.profile).sources.filter(source => source.name === 'Local preset')
  expect(first).toHaveLength(1)
  expect(await row.evaluate((element, node) => element === node, node)).toBe(true)
  await expect(providerField(window, 'API Key')).toHaveValue(providerGateway.key('primary'))
  await editor.getByRole('button', { name: 'Add', exact: true }).click()
  await expect.poll(async () => managementApp.app.evaluate(() => (globalThis as unknown as { presetSwitchState: { calls: number } }).presetSwitchState.calls)).toBe(2)
  await expect(editor.getByRole('alert')).toHaveText('Save failed')
  const retried = readProviderConfiguration(managementApp.profile).sources.filter(source => source.name === 'Local preset')
  expect(retried).toHaveLength(1)
  expect(retried[0].id).toBe(first[0].id)
  await expect(editor).toBeVisible()
})

test('synthetic login completion reveals a newly reported OAuth account', uiAcceptance('models.accounts.in-place-login-success'), async ({ window, managementApp, providerGateway }) => {
  await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
  const snapshot = await window.evaluate(async () => (window as unknown as { halo: HaloAPI }).halo.getConfig())
  expect(snapshot.success).toBe(true)
  const original = readProviderConfiguration(managementApp.profile)
  await managementApp.app.evaluate(({ ipcMain }, config) => {
    const state = { complete: false, finish: null as null | (() => void) }
    ;(globalThis as unknown as { syntheticLoginSuccess: typeof state }).syntheticLoginSuccess = state
    for (const channel of ['auth:start-login', 'auth:complete-login', 'auth:cancel-login', 'config:get']) ipcMain.removeHandler(channel)
    ipcMain.handle('auth:start-login', () => ({ success: true, data: { loginId: 'local-success-login', state: 'local-success-state', userCode: 'TEST-CODE', verificationUri: 'https://example.invalid/device' } }))
    ipcMain.handle('auth:complete-login', () => new Promise(resolve => { state.finish = () => { state.complete = true; resolve({ success: true }) } }))
    ipcMain.handle('auth:cancel-login', () => ({ success: true }))
    ipcMain.handle('config:get', () => ({ success: true, data: state.complete ? { ...config, aiSources: { ...config.aiSources, sources: [...config.aiSources!.sources, { ...config.aiSources!.sources.find(source => source.id === 'inline-oauth')!, id: 'synthetic-new-oauth', name: 'New local OAuth account' }] } } : config }))
  }, snapshot.data as HaloConfig)
  await navigateToSettings(window)
  const row = window.locator('[data-ai-provider-row="chatgpt"]')
  await positionEntry(row)
  await row.getByRole('button').first().click()
  await expect(row.getByText('TEST-CODE', { exact: true })).toBeVisible()
  await managementApp.app.evaluate(() => (globalThis as unknown as { syntheticLoginSuccess: { finish: () => void } }).syntheticLoginSuccess.finish())
  await expect(row.locator('[data-ai-login-panel]')).toHaveCount(0)
  const card = sourceCard(window, 'New local OAuth account')
  await expect(card).toBeInViewport()
  await expect(card).toBeFocused()
  await expect(card).toHaveClass(/pulse-highlight/)
  expect(readProviderConfiguration(managementApp.profile)).toEqual(original)
})

test('a refused account deletion reports at the retained card', uiAcceptance('models.accounts.in-place-delete-failure'), async ({ window, managementApp, providerGateway }) => {
  await seedAccounts(window, providerGateway.url('primary'), providerGateway.key('primary'))
  await navigateToSettings(window)
  const before = readProviderConfiguration(managementApp.profile)
  await managementApp.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai-sources:delete-source')
    ipcMain.handle('ai-sources:delete-source', () => ({ success: false, error: 'Synthetic delete failure' }))
  })
  const card = sourceCard(window, 'Inline account 23')
  await card.locator('[data-ai-source-header]').click()
  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  await window.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(card.getByRole('alert')).toHaveText('Delete failed')
  expect(readProviderConfiguration(managementApp.profile)).toEqual(before)
})
