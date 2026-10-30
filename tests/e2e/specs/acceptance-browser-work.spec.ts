import { randomUUID } from 'node:crypto'
import type { ElectronApplication, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import {
  test, expect, acceptance, openAiBrowser, runBrowserChat, readGuest, parseBrowserState,
  READ_BROWSER_STATE, revealFromReply, guestPoint, paintAiBrowser,
} from '../fixtures/acceptance-browser-work'
import { guestIdentity } from '../fixtures/browser-site'
import { navigateToChat } from '../fixtures/helpers'
import { preserveSystemClipboard } from '../fixtures/clipboard'

test.setTimeout(180000)

type OpenedBrowser = Awaited<ReturnType<typeof openAiBrowser>>
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function assertOwnedPage(window: Page, app: ElectronApplication, opened: OpenedBrowser, url: string) {
  const result = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.listAIBrowserLivePages())
  expect(result.success).toBe(true)
  expect(result.data).toContainEqual(expect.objectContaining({ viewId: opened.viewId, url, owned: true, active: true, conversationId: opened.turn.conversationId, spaceId: opened.turn.spaceId }))
  expect(await guestIdentity(app, url)).toBe(opened.guestId)
  expect(await app.evaluate(({ webContents }, { targetId, controlId }) => {
    const target = webContents.fromId(targetId)!
    const control = webContents.fromId(controlId)!
    return { target: target.getType(), control: control.getType(), sameHost: target.hostWebContents?.id === control.hostWebContents?.id }
  }, { targetId: opened.guestId, controlId: opened.controlGuestId })).toEqual({ target: 'webview', control: 'webview', sameHost: true })
  expect(await readGuest(app, opened.controlGuestId)).toEqual(opened.control)
}

async function typeField(window: Page, app: ElectronApplication, guestId: number, value: string, frame = false) {
  const point = await guestPoint(window, app, guestId, '#draft', frame)
  await window.mouse.click(point.x, point.y)
  await window.keyboard.press(`${modifier}+A`)
  const selection = await readGuest(app, guestId)
  const field = frame ? selection.frame!.draft : selection.draft
  expect(field.start).toBe(0)
  expect(field.end).toBe(field.value.length)
  await window.keyboard.type(value)
  await expect.poll(async () => {
    const current = await readGuest(app, guestId)
    return frame ? current.frame!.draft.value : current.draft.value
  }).toBe(value)
}

async function clickAction(window: Page, app: ElectronApplication, guestId: number) {
  const before = await readGuest(app, guestId)
  const point = await guestPoint(window, app, guestId, '#action')
  await window.mouse.click(point.x, point.y)
  await expect.poll(async () => (await readGuest(app, guestId)).clicks).toBe(before.clicks + 1)
  expect((await readGuest(app, guestId)).lastClick).toEqual({ target: 'action', trusted: true })
}

async function scrollGuest(window: Page, app: ElectronApplication, guestId: number) {
  const guest = window.locator('webview[aria-hidden="false"]')
  const box = (await guest.boundingBox())!
  await window.mouse.move(box.x + box.width - 30, box.y + box.height - 40)
  await window.mouse.wheel(0, 500)
  await expect.poll(async () => (await readGuest(app, guestId)).scroll).toBeGreaterThan(200)
}

test('a real browser conversation reveals, hides and reopens its entered page before continuing navigation', acceptance('browser.work.reveal'), async ({ acceptanceApp, model, window, browserWorkSite }, info) => {
  await navigateToChat(window)
  const opened = await openAiBrowser(window, acceptanceApp.app, model, browserWorkSite, `AI entered ${randomUUID()}`)
  await revealFromReply(window, opened.answer)
  await paintAiBrowser(window, acceptanceApp.app, opened.viewId)
  expect(await readGuest(acceptanceApp.app, opened.guestId)).toEqual(opened.target)
  const value = `Revealed user draft ${randomUUID()}`
  await typeField(window, acceptanceApp.app, opened.guestId, value)
  await clickAction(window, acceptanceApp.app, opened.guestId)
  await scrollGuest(window, acceptanceApp.app, opened.guestId)
  const retained = await readGuest(acceptanceApp.app, opened.guestId)

  for (const entry of ['edge', 'reply'] as const) {
    await window.getByRole('button', { name: 'Collapse canvas', exact: true }).click()
    await expect(window.locator(`webview[data-browser-page-id="${opened.viewId}"]`)).toHaveAttribute('aria-hidden', 'true')
    expect(await readGuest(acceptanceApp.app, opened.guestId)).toEqual(retained)
    if (entry === 'edge') await window.getByRole('button', { name: 'Expand canvas', exact: true }).click()
    else await revealFromReply(window, opened.answer)
    await paintAiBrowser(window, acceptanceApp.app, opened.viewId)
    expect(await readGuest(acceptanceApp.app, opened.guestId)).toEqual(retained)
    await assertOwnedPage(window, acceptanceApp.app, opened, browserWorkSite.targetUrl)
  }
  const continued = await runBrowserChat(window, model, `Inspect the page I edited, then continue on the same browser page to ${browserWorkSite.nextUrl} and inspect the new document.`, [
    { name: 'browser_evaluate', input: { function: READ_BROWSER_STATE } },
    { name: 'browser_navigate', input: { url: browserWorkSite.nextUrl } },
    { name: 'browser_evaluate', input: { function: READ_BROWSER_STATE } },
  ])
  expect(continued.turn.conversationId).toBe(opened.turn.conversationId)
  expect(parseBrowserState(continued.results[0])).toEqual(retained)
  const navigated = parseBrowserState(continued.results[2])
  expect(navigated.url).toBe(browserWorkSite.nextUrl)
  expect(navigated.nonce).not.toBe(retained.nonce)
  await assertOwnedPage(window, acceptanceApp.app, opened, browserWorkSite.nextUrl)
  await info.attach('retained-browser-after-navigation', { body: await paintAiBrowser(window, acceptanceApp.app, opened.viewId), contentType: 'image/png' })
  await info.attach('revealed-browser-identity', { body: JSON.stringify({ viewId: opened.viewId, guestId: opened.guestId, retained, navigated }), contentType: 'application/json' })
})

test('closing an AI viewing tab keeps its live page and the session tray reopens that exact page', acceptance('browser.recovery.close-view'), async ({ acceptanceApp, model, window, browserWorkSite }, info) => {
  await navigateToChat(window)
  const opened = await openAiBrowser(window, acceptanceApp.app, model, browserWorkSite, `AI retained ${randomUUID()}`)
  await revealFromReply(window, opened.answer)
  await paintAiBrowser(window, acceptanceApp.app, opened.viewId)
  expect(await readGuest(acceptanceApp.app, opened.guestId)).toEqual(opened.target)
  await typeField(window, acceptanceApp.app, opened.guestId, `User retained ${randomUUID()}`)
  await clickAction(window, acceptanceApp.app, opened.guestId)
  await scrollGuest(window, acceptanceApp.app, opened.guestId)
  const retained = await readGuest(acceptanceApp.app, opened.guestId)
  const tab = window.locator('.canvas-tab.active')
  await tab.getByTitle('Close (⌘W / Middle-click)', { exact: true }).click()
  await expect(window.locator('.canvas-tab')).toHaveCount(0)
  await expect(window.locator(`webview[data-browser-page-id="${opened.viewId}"]`)).toHaveAttribute('aria-hidden', 'true')
  expect(await readGuest(acceptanceApp.app, opened.guestId)).toEqual(retained)
  await assertOwnedPage(window, acceptanceApp.app, opened, browserWorkSite.targetUrl)
  await window.locator('[aria-haspopup="dialog"]').filter({ hasText: '2 sessions running' }).click()
  const sessions = window.getByRole('dialog').filter({ hasText: 'Active sessions' })
  await expect(sessions).toBeVisible()
  await sessions.locator('button[title="Open"]').filter({ hasText: browserWorkSite.targetTitle }).click()
  await expect(sessions).toHaveCount(0)
  await info.attach('reopened-live-browser', { body: await paintAiBrowser(window, acceptanceApp.app, opened.viewId), contentType: 'image/png' })
  expect(await readGuest(acceptanceApp.app, opened.guestId)).toEqual(retained)
  await assertOwnedPage(window, acceptanceApp.app, opened, browserWorkSite.targetUrl)
  const continued = await runBrowserChat(window, model, 'Read the current browser document after I reopened its viewing tab.', [
    { name: 'browser_evaluate', input: { function: READ_BROWSER_STATE } },
  ])
  expect(continued.turn.conversationId).toBe(opened.turn.conversationId)
  expect(parseBrowserState(continued.results[0])).toEqual(retained)
  await info.attach('closed-view-retained-state', { body: JSON.stringify({ viewId: opened.viewId, guestId: opened.guestId, retained }), contentType: 'application/json' })
})

test('real user typing and paste reach normal and iframe fields while cancelled shortcuts spare controls and the host composer', acceptance('browser.work.input'), async ({ acceptanceApp, model, window, browserWorkSite }, info) => {
  await navigateToChat(window)
  const opened = await openAiBrowser(window, acceptanceApp.app, model, browserWorkSite, `AI input ${randomUUID()}`)
  await revealFromReply(window, opened.answer)
  await paintAiBrowser(window, acceptanceApp.app, opened.viewId)
  expect(await readGuest(acceptanceApp.app, opened.guestId)).toEqual(opened.target)
  const hostDraft = `Independent chat draft ${randomUUID()}`
  await window.locator('textarea').first().fill(hostDraft)
  const restoreClipboard = await preserveSystemClipboard(acceptanceApp.app)
  try {
    await acceptanceApp.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), `Owned clipboard ${randomUUID()}`)
    const mainValue = `Main user input 中文 ${randomUUID()}`
    const frameValue = `Frame user input 中文 ${randomUUID()}`
    for (const [frame, value] of [[false, mainValue], [true, frameValue]] as const) {
      await typeField(window, acceptanceApp.app, opened.guestId, value, frame)
      await window.keyboard.press(`${modifier}+A`)
      await window.keyboard.press(`${modifier}+C`)
      expect(await acceptanceApp.app.evaluate(({ clipboard }, value) => clipboard.readText() === value, value), 'Only owned copied text may be pasted').toBe(true)
      const paste = await guestPoint(window, acceptanceApp.app, opened.guestId, '#paste', frame)
      await window.mouse.click(paste.x, paste.y)
      await window.keyboard.press(`${modifier}+V`)
      await expect.poll(async () => {
        const state = await readGuest(acceptanceApp.app, opened.guestId)
        return frame ? state.frame!.paste.value : state.paste.value
      }).toBe(value)
      const state = await readGuest(acceptanceApp.app, opened.guestId)
      const edited = frame ? state.frame! : state
      expect(edited.pastes).toEqual([{ target: 'paste', trusted: true, text: value }])
      expect(edited.inputs.filter(event => ['draft', 'paste'].includes(event.target)).length).toBeGreaterThan(0)
      expect(edited.inputs.filter(event => ['draft', 'paste'].includes(event.target)).every(event => event.trusted)).toBe(true)
    }

    for (const frame of [false, true]) {
      const point = await guestPoint(window, acceptanceApp.app, opened.guestId, '#cancel', frame)
      await window.mouse.click(point.x, point.y)
      const before = await readGuest(acceptanceApp.app, opened.guestId)
      const protectedBefore = frame ? before.frame! : before
      await window.keyboard.press(`${modifier}+A`)
      await window.keyboard.press(`${modifier}+V`)
      const after = await readGuest(acceptanceApp.app, opened.guestId)
      const protectedAfter = frame ? after.frame! : after
      expect(protectedAfter.protected).toEqual(protectedBefore.protected)
      expect(protectedAfter.inputs).toEqual(protectedBefore.inputs)
      expect(protectedAfter.cancelledKeys).toEqual([{ key: 'a', trusted: true, cancelled: true }, { key: 'v', trusted: true, cancelled: true }])
    }
    const userState = await readGuest(acceptanceApp.app, opened.guestId)
    expect(userState.draft.value).toBe(mainValue)
    expect(userState.paste.value).toBe(mainValue)
    expect(userState.frame!.draft.value).toBe(frameValue)
    expect(userState.frame!.paste.value).toBe(frameValue)
    expect(userState.control).toEqual(opened.target.control)
    expect(userState.frame!.control).toEqual(opened.target.frame!.control)
    await expect(window.locator('textarea').first()).toHaveValue(hostDraft)
    expect(await acceptanceApp.app.evaluate(({ clipboard }, value) => clipboard.readText() === value, frameValue)).toBe(true)
    await assertOwnedPage(window, acceptanceApp.app, opened, browserWorkSite.targetUrl)

    const observed = await runBrowserChat(window, model, 'Press the paste shortcut in the browser field I selected, respecting its cancellation, then inspect the current normal and iframe fields.', [
      { name: 'browser_press_key', input: { key: `${modifier}+V` } },
      { name: 'browser_evaluate', input: { function: READ_BROWSER_STATE } },
    ])
    expect(observed.turn.conversationId).toBe(opened.turn.conversationId)
    const expected = { ...userState, frame: { ...userState.frame!, cancelledKeys: [...userState.frame!.cancelledKeys, { key: 'v', trusted: true, cancelled: true }] } }
    expect(parseBrowserState(observed.results[1])).toEqual(expected)
    expect(await readGuest(acceptanceApp.app, opened.guestId)).toEqual(expected)
    await expect(window.locator('textarea').first()).toHaveValue('')
    expect(await acceptanceApp.app.evaluate(({ clipboard }, value) => clipboard.readText() === value, frameValue)).toBe(true)
    await assertOwnedPage(window, acceptanceApp.app, opened, browserWorkSite.targetUrl)
    await info.attach('browser-normal-and-frame-input', { body: JSON.stringify({ viewId: opened.viewId, guestId: opened.guestId, userState, observed: expected }), contentType: 'application/json' })
  } finally { await restoreClipboard() }
})
