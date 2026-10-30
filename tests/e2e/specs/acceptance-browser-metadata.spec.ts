import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { test, observeBrowserMetadata, metadataWasReceived } from '../fixtures/acceptance-browser-metadata'
import { expect, acceptance, openAiBrowser, revealFromReply, readGuest, paintAiBrowser, runBrowserChat, parseBrowserState, READ_BROWSER_STATE } from '../fixtures/acceptance-browser-work'
import { readAcceptanceConversation } from '../fixtures/acceptance-app'
import { navigateToChat } from '../fixtures/helpers'
import { guestIdentity } from '../fixtures/browser-site'

test.setTimeout(180000)

async function composerState(page: Page) {
  return page.locator('textarea').first().evaluate(element => {
    const input = element as HTMLTextAreaElement
    return { value: input.value, start: input.selectionStart, end: input.selectionEnd, active: document.activeElement === input, focus: document.hasFocus() }
  })
}

test('loaded and asynchronous page metadata identifies both owned pages without reopening a collapsed canvas or stealing focus', acceptance('browser.work.live-metadata'), async ({ acceptanceApp, model, window, browserMetadataSite }, info) => {
  await navigateToChat(window)
  const opened = await openAiBrowser(window, acceptanceApp.app, model, browserMetadataSite, `Metadata draft ${randomUUID()}`)
  const owner = (await readAcceptanceConversation(window, opened.turn.spaceId, opened.turn.conversationId)).title
  const rowLabel = (title: string) => `${owner} · ${title}`
  const tray = window.getByRole('dialog').filter({ has: window.getByText('Active sessions', { exact: true }) })
  const openTray = async () => {
    await window.getByRole('button', { name: '2 sessions running', exact: true }).click()
    await expect(tray).toBeVisible()
  }
  const row = (title: string) => tray.getByRole('button').filter({ has: window.getByText(rowLabel(title), { exact: true }) })
  await openTray()
  await expect(row(browserMetadataSite.targetTitle)).toHaveCount(1)
  await expect(row(browserMetadataSite.controlTitle)).toHaveCount(1)
  await window.keyboard.press('Escape')
  await expect(tray).toHaveCount(0)
  await revealFromReply(window, opened.answer)
  await paintAiBrowser(window, acceptanceApp.app, opened.viewId)
  expect(await readGuest(acceptanceApp.app, opened.guestId)).toEqual(opened.target)
  await window.getByRole('button', { name: 'Collapse canvas', exact: true }).click()
  const composer = window.locator('textarea').first()
  await composer.fill(`Preserved composer ${randomUUID()}`)
  await composer.press('ArrowLeft')
  const focused = await composerState(window)
  expect(focused.active).toBe(true)
  expect(focused.focus).toBe(true)
  const stop = await observeBrowserMetadata(window)
  try {
    const changes = [
      { role: 'control' as const, viewId: opened.controlViewId, title: `Changed inactive control ${randomUUID()}`, navigate: false },
      { role: 'target' as const, viewId: opened.viewId, title: `Changed active target ${randomUUID()}`, navigate: false },
      { role: 'target' as const, viewId: opened.viewId, title: `Navigated active target ${randomUUID()}`, navigate: true },
    ]
    let controlUrl = browserMetadataSite.controlUrl
    let targetUrl = browserMetadataSite.targetUrl
    for (const change of changes) {
      const update = browserMetadataSite.update(change.role, change.title, change.navigate)
      await expect.poll(() => metadataWasReceived(window, change.viewId, update), { timeout: 20000 }).toBe(true)
      await window.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await composerState(window)).toEqual(focused)
      await expect(window.getByRole('button', { name: 'Expand canvas', exact: true })).toBeVisible()
      await expect(window.locator(`webview[data-browser-page-id="${opened.viewId}"]`)).toHaveAttribute('aria-hidden', 'true')
      const live = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.listAIBrowserLivePages())
      expect(live.success).toBe(true)
      expect(live.data).toContainEqual(expect.objectContaining({ viewId: opened.viewId, conversationId: opened.turn.conversationId, active: true, owned: true }))
      expect(live.data).toContainEqual(expect.objectContaining({ viewId: opened.controlViewId, active: false, owned: true }))
      if (change.role === 'control') controlUrl = update.url
      else targetUrl = update.url
      expect(await guestIdentity(acceptanceApp.app, controlUrl)).toBe(opened.controlGuestId)
      expect(await guestIdentity(acceptanceApp.app, targetUrl)).toBe(opened.guestId)
      expect(await readGuest(acceptanceApp.app, opened.controlGuestId)).toEqual({ ...opened.control, url: controlUrl })
      if (!change.navigate) expect(await readGuest(acceptanceApp.app, opened.guestId)).toEqual({ ...opened.target, url: targetUrl })
      else {
        const script = `(() => {
          const frame = document.querySelector('#editing-frame')?.contentWindow;
          return location.href === ${JSON.stringify(targetUrl)} && document.readyState === 'complete' &&
            typeof window.carrierNonce === 'string' && window.carrierNonce !== ${JSON.stringify(opened.target.nonce)} &&
            !!document.querySelector('#draft') && frame?.document.readyState === 'complete' &&
            typeof frame.carrierNonce === 'string' && !!frame.document.querySelector('#draft');
        })()`
        await expect.poll(() => acceptanceApp.app.evaluate(async ({ webContents }, { guestId, script }) => {
          try { return await webContents.fromId(guestId)!.executeJavaScript(script) }
          catch { return false }
        }, { guestId: opened.guestId, script }), { timeout: 20000, message: 'The actual navigated document and its frame must finish loading before their state is read' }).toBe(true)
        expect(await composerState(window)).toEqual(focused)
        await expect(window.getByRole('button', { name: 'Expand canvas', exact: true })).toBeVisible()
      }
    }
    const navigated = await readGuest(acceptanceApp.app, opened.guestId)
    expect(navigated.nonce).not.toBe(opened.target.nonce)
    await revealFromReply(window, opened.answer)
    await paintAiBrowser(window, acceptanceApp.app, opened.viewId)
    await expect(window.getByPlaceholder(/Enter URL or search Bing/)).toHaveValue(targetUrl)
    expect(await readGuest(acceptanceApp.app, opened.guestId)).toEqual(navigated)
    await window.locator('.canvas-tab.active').getByTitle('Close (⌘W / Middle-click)', { exact: true }).click()
    await expect(window.locator('.canvas-tab')).toHaveCount(0)
    await openTray()
    await expect(row(changes[0].title)).toHaveCount(1)
    await expect(row(changes[2].title)).toHaveCount(1)
    await row(changes[2].title).click()
    await expect(tray).toHaveCount(0)
    await info.attach('live-metadata-revealed-page', { body: await paintAiBrowser(window, acceptanceApp.app, opened.viewId), contentType: 'image/png' })
    await expect(window.getByPlaceholder(/Enter URL or search Bing/)).toHaveValue(targetUrl)
    expect(await readGuest(acceptanceApp.app, opened.guestId)).toEqual(navigated)
    const continued = await runBrowserChat(window, model, 'Read the page after its own title and navigation updates, without changing the selected page.', [{ name: 'browser_evaluate', input: { function: READ_BROWSER_STATE } }])
    expect(continued.turn.conversationId).toBe(opened.turn.conversationId)
    expect(parseBrowserState(continued.results[0])).toEqual(navigated)
    expect(await readGuest(acceptanceApp.app, opened.controlGuestId)).toEqual({ ...opened.control, url: controlUrl })
    await info.attach('live-page-metadata-control', { body: JSON.stringify({ focused, changes, viewId: opened.viewId, guestId: opened.guestId, navigated }), contentType: 'application/json' })
  } finally { await stop() }
})
