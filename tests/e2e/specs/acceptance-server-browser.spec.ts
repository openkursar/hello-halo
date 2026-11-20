import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import { createTestConfigDir, getAppEntryPath, launchElectronApp, cleanupTestConfigDir } from '../fixtures/electron'
import { browserWorkHtml, readGuest, revealFromReply } from '../fixtures/acceptance-browser-work'
import { guestIdentity } from '../fixtures/browser-site'
import { startLink } from '../fixtures/acceptance-remote'
import { replyWithModelTool } from '../fixtures/acceptance-tool-discovery'
import type { AcceptanceModel } from '../fixtures/acceptance-model'
import { navigateToChat, setTheme, waitForHomePage } from '../fixtures/helpers'
import { installRemoteLoopbackGuard, readRemoteLoopbackGuard } from '../fixtures/acceptance-remote-lifecycle'
import type { HaloAPI } from '../../../src/preload'
import type { RemoteAccessStatus } from '../../../src/main/services/remote'

async function listen(listener: ReturnType<typeof createServer>) {
  await new Promise<void>((done, fail) => { listener.once('error', fail); listener.listen(0, '127.0.0.1', done) })
  return (listener.address() as AddressInfo).port
}

async function close(listener: ReturnType<typeof createServer>) {
  listener.closeAllConnections()
  await new Promise<void>((done, fail) => listener.close(error => error ? fail(error) : done()))
}

async function ask(page: Page, model: AcceptanceModel, question: string, tool: string, input: Record<string, unknown>): Promise<{ answer: string; result: string }> {
  const id = randomUUID()
  const answer = `Completed browser action ${id}`
  const issues: string[] = []
  let result: string | undefined
  let failed = false
  model.respond(request => {
    if (!request.lastUserText.includes(question)) return { text: 'Browser work' }
    const receipt = request.toolResults.find(item => item.id === id)
    if (!receipt) return replyWithModelTool(request, tool, input, id, issues)
    result = receipt.text
    failed = receipt.error
    return { text: answer }
  })
  await page.locator('textarea').first().fill(question)
  await page.locator('[data-onboarding="send-button"]').click()
  await expect(page.locator('.message-assistant').last()).toContainText(answer, { timeout: 60000 })
  await expect(page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
  expect(issues).toEqual([])
  expect(failed).toBe(false)
  expect(result).toBeDefined()
  return { answer, result: result! }
}

for (const host of ['desktop', 'server'] as const) test(`the web client operates the AI page on ${host}, reconnects and releases hidden capture`, acceptance('remote.browser.same-page', { host }), async ({ model, browser, aiSource }, info) => {
  const serverMode = host === 'server'
  test.setTimeout(150000)
  const site = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(browserWorkHtml('Remote shared draft'))
  })
  const url = `http://127.0.0.1:${await listen(site)}/page`
  const portReservation = createServer()
  let port = await listen(portReservation)
  await close(portReservation)
  const entry = getAppEntryPath()
  const profile = createTestConfigDir(entry, [], { sdkEngine: 'halo' })
  if (!serverMode) {
    const configPath = join(profile, '.halo/config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const now = new Date().toISOString()
    config.api = { ...config.api, ...aiSource }
    config.aiSources = { version: 2, currentId: 'acceptance-local', sources: [{
      id: 'acceptance-local', name: 'Local acceptance model', authType: 'api-key', ...aiSource,
      availableModels: [{ id: aiSource.model, name: aiSource.model }], createdAt: now, updatedAt: now,
    }] }
    writeFileSync(configPath, JSON.stringify(config))
  }
  let token: string = randomUUID()
  let app: ElectronApplication | undefined
  let link: Awaited<ReturnType<typeof startLink>> | undefined
  const client = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'en-US' })
  const frames: Array<{ at: number; bytes: number }> = []
  const operations: string[] = []
  try {
    app = await launchElectronApp(entry, profile, { env: {
      HALO_SERVER_MODE: serverMode ? '1' : '0', PORT: String(port), HALO_REMOTE_PASSWORD: serverMode ? token : '',
      HALO_AI_PROVIDER: 'openai', HALO_AI_API_URL: model.url, HALO_AI_API_KEY: 'local-scripted-endpoint', HALO_AI_MODEL: 'gpt-4o',
    } })
    if (!serverMode) {
      const desktop = await app.firstWindow()
      await waitForHomePage(desktop)
      await app.evaluate(installRemoteLoopbackGuard)
      const enabled = await desktop.evaluate(async candidate =>
        (globalThis as unknown as { halo: HaloAPI }).halo.enableRemoteAccess(candidate), port)
      expect(enabled.success).toBe(true)
      const status = enabled.data as RemoteAccessStatus
      expect(status.server.token).toBeTruthy()
      port = status.server.port
      token = status.server.token!
      const binding = await app.evaluate(readRemoteLoopbackGuard)
      expect(binding.violations).toEqual([])
      expect(binding.attempts).toContainEqual(expect.objectContaining({
        listening: true, actual: expect.objectContaining({ address: '127.0.0.1', port }),
      }))
    }
    await expect.poll(async () => {
      const response = await client.request.get(`http://127.0.0.1:${port}/api/system/runtime`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 2500,
      }).catch(() => null)
      return response?.ok() ? (await response.json()).data?.serverMode : undefined
    }, { timeout: 30000 }).toBe(serverMode)
    link = await startLink(port)
    const page = await client.newPage()
    page.on('websocket', socket => {
      if (!socket.url().endsWith('/ws')) return
      socket.on('framereceived', ({ payload }) => {
        const message = JSON.parse(payload.toString())
        if (message.channel === 'browser:live-frame') frames.push({ at: Date.now(), bytes: Buffer.byteLength(payload) })
      })
      socket.on('framesent', ({ payload }) => {
        const { type } = JSON.parse(payload.toString())
        if (typeof type === 'string' && type.startsWith('browser-live-') && type !== 'browser-live-ack') operations.push(type)
      })
    })
    await page.goto(link.url)
    await page.getByPlaceholder('Access Code', { exact: true }).fill(token)
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await navigateToChat(page)
    expect(await page.evaluate(() => 'halo' in globalThis)).toBe(false)
    const opened = await ask(page, model, `Open the local draft ${url}.`, 'browser_navigate', { url })
    const guestId = await guestIdentity(app, url)
    expect(guestId).toBeGreaterThan(0)
    expect(frames).toHaveLength(0)
    expect(operations).toHaveLength(0)

    await revealFromReply(page, opened.answer)
    const image = page.getByRole('img', { name: /AI Browser|Remote shared draft/ }).last()
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(100)
    const box = (await image.boundingBox())!
    const relativePoint = await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript(`(() => {
      const rect = document.querySelector('#draft').getBoundingClientRect();
      return { x: (rect.x + rect.width / 2) / innerWidth, y: (rect.y + rect.height / 2) / innerHeight };
    })()`), guestId)
    await page.mouse.click(box.x + box.width * relativePoint.x, box.y + box.height * relativePoint.y)
    await expect(page.getByRole('textbox', { name: 'Keyboard input for this page' })).toBeFocused()
    const draft = `Remote entry ${randomUUID()}`
    await page.keyboard.insertText(draft)
    await expect.poll(async () => (await readGuest(app!, guestId)).draft.value).toBe(draft)

    link.disconnect()
    await expect(page.getByText('Reconnecting...', { exact: true })).toBeVisible()
    link.reconnect()
    await expect(page.getByText('Reconnecting...', { exact: true })).toHaveCount(0, { timeout: 30000 })
    await expect(image).toBeVisible()
    expect(await guestIdentity(app, url)).toBe(guestId)
    expect((await readGuest(app, guestId)).draft.value).toBe(draft)
    expect(operations.filter(type => type === 'browser-live-attach')).toHaveLength(2)

    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 900 })
      for (const theme of ['dark', 'light'] as const) {
        await setTheme(page, theme)
        await expect(image).toBeVisible()
        const keyboard = page.getByRole('button', { name: 'Type on the page', exact: true })
        await expect(keyboard).toBeInViewport({ ratio: 1 })
        await info.attach(`server-browser-${width}-${theme}`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' })
      }
    }
    await page.setViewportSize({ width: 1200, height: 900 })
    await page.getByRole('button', { name: 'Collapse canvas', exact: true }).click()
    await expect.poll(() => operations.at(-1)).toBe('browser-live-detach')
    await expect(image).toHaveCount(0)
    const reviewed = await ask(page, model, 'Read the draft I edited on your page.', 'browser_snapshot', {})
    expect(reviewed.result).toContain(draft)
    expect(reviewed.result).toContain('the user operated this page')
    expect(await guestIdentity(app, url)).toBe(guestId)
    expect(model.errors).toEqual([])
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(!serverMode)
    await info.attach('server-browser-transport', { body: JSON.stringify({ frames, operations, samePage: true }), contentType: 'application/json' })
  } finally {
    const log = `${profile}/.halo/logs/main.log`
    try { await info.attach('server-browser-main-log', { body: readFileSync(log).subarray(-300000), contentType: 'text/plain' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await client.close()
    await link?.close()
    if (app) {
      await app.close()
      cleanupTestConfigDir(profile)
    }
    await close(site)
  }
})
