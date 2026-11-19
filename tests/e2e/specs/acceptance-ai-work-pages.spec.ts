import { randomUUID } from 'node:crypto'
import type { ElectronApplication, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import {
  test, expect, acceptance, openAiBrowser, runBrowserChat, readGuest, parseBrowserState,
  READ_BROWSER_STATE, guestPoint, paintAiBrowser,
} from '../fixtures/acceptance-browser-work'
import { guestIdentity } from '../fixtures/browser-site'
import { navigateToChat, navigateToWorkspaces } from '../fixtures/helpers'
import { seedManagedSpace, openWorkspaceMenu, workspaceCard } from '../fixtures/acceptance-management'
import { scriptedTurn, expandHandle, statusLine, tabTitled, expectHandleCount } from '../fixtures/acceptance-ai-work'

test.setTimeout(240000)

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function typeDraft(window: Page, app: ElectronApplication, guestId: number, value: string) {
  const point = await guestPoint(window, app, guestId, '#draft')
  await window.mouse.click(point.x, point.y)
  await window.keyboard.press(`${modifier}+A`)
  await window.keyboard.type(value)
  await expect.poll(async () => (await readGuest(app, guestId)).draft.value).toBe(value)
}

async function livePages(window: Page) {
  const result = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.listAIBrowserLivePages())
  expect(result.success).toBe(true)
  return result.data!
}

test('closing the AI\'s page asks with wording that follows its work, and confirming ends the page', acceptance('files.ai-work.close-page'), async ({ acceptanceApp, model, window, browserWorkSite }, info) => {
  await navigateToChat(window)
  const opened = await openAiBrowser(window, acceptanceApp.app, model, browserWorkSite, `Close page ${randomUUID()}`)
  await expandHandle(window).click()
  const tab = tabTitled(window, browserWorkSite.targetTitle)
  await tab.click()
  await paintAiBrowser(window, acceptanceApp.app, opened.viewId)

  // Fresh work on the page: it reads as operated for ten seconds after.
  await runBrowserChat(window, model, 'Look at the page once more.', [{ name: 'browser_evaluate', input: { function: READ_BROWSER_STATE } }])
  await expect(statusLine(window)).toContainText('AI is operating')
  await tab.hover()
  await tab.locator('.canvas-tab-close').click()
  const question = window.getByRole('alertdialog', { name: 'Close this page?', exact: true })
  await expect(question).toContainText('The AI is working on it right now; closing it interrupts what it is doing.')
  await info.attach('close-page-operating', { body: await window.screenshot(), contentType: 'image/png' })
  await question.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(question).toHaveCount(0)
  await expect(tab).toHaveClass(/\bactive\b/)
  expect(await guestIdentity(acceptanceApp.app, browserWorkSite.targetUrl)).toBe(opened.guestId)

  await expect(statusLine(window)).toContainText('AI is idle', { timeout: 20000 })
  await tab.hover()
  await tab.locator('.canvas-tab-close').click()
  await expect(question).toContainText('The AI opened this page; what is on it will not be kept after closing.')
  await info.attach('close-page-idle', { body: await window.screenshot(), contentType: 'image/png' })
  await question.getByRole('button', { name: 'Close page', exact: true }).click()
  await expect(question).toHaveCount(0)
  await expect(tab).toHaveCount(0)
  await expect.poll(async () => (await livePages(window)).some(page => page.viewId === opened.viewId)).toBe(false)
  await expect.poll(() => guestIdentity(acceptanceApp.app, browserWorkSite.targetUrl)).toBe(0)
  // The control page the user did not close is untouched.
  expect(await readGuest(acceptanceApp.app, opened.controlGuestId)).toEqual(opened.control)
  await expect(window.locator('.canvas-tab').filter({ has: window.locator('.canvas-tab-ai-dot') })).toHaveCount(1)
})

test('the AI brings its page in front of me, I act on it, and it continues from what I did', acceptance('files.ai-work.show-page'), async ({ acceptanceApp, model, window, browserWorkSite }, info) => {
  await navigateToChat(window)
  const opened = await openAiBrowser(window, acceptanceApp.app, model, browserWorkSite, `Show page ${randomUUID()}`)
  await expect(window.locator('.canvas-tab')).toHaveCount(0)
  await expectHandleCount(window, 2)
  await info.attach('pages-added-quietly', { body: await window.screenshot(), contentType: 'image/png' })

  const shown = await scriptedTurn(window, model, 'Bring up the page so I can sign in there.', [{ name: 'canvas_show', input: { target: 'page' } }])
  expect(shown.results[0]).toMatch(/^Shown: the user now sees the page/)
  await expect(tabTitled(window, browserWorkSite.targetTitle)).toHaveClass(/\bactive\b/)
  await paintAiBrowser(window, acceptanceApp.app, opened.viewId)
  await info.attach('page-shown', { body: await window.screenshot(), contentType: 'image/png' })

  const value = `Signed in by the user ${randomUUID()}`
  await typeDraft(window, acceptanceApp.app, opened.guestId, value)
  const continued = await runBrowserChat(window, model, 'I signed in; continue on the same page.', [{ name: 'browser_evaluate', input: { function: READ_BROWSER_STATE } }])
  expect(continued.turn.conversationId).toBe(opened.turn.conversationId)
  expect(parseBrowserState(continued.results[0]).draft.value).toBe(value)
  expect(await guestIdentity(acceptanceApp.app, browserWorkSite.targetUrl)).toBe(opened.guestId)
})

test('a released page in a workspace I left is destroyed when I remove that workspace', acceptance('files.ai-work.adopted-page-cleanup'), async ({ acceptanceApp, model, window, browserWorkSite }) => {
  const origin = await seedManagedSpace(window, 'Page workspace')
  const other = await seedManagedSpace(window, 'Other workspace')
  await navigateToWorkspaces(window)
  await workspaceCard(window, origin.name).click()
  const opened = await openAiBrowser(window, acceptanceApp.app, model, browserWorkSite, `Parked page ${randomUUID()}`)
  expect(opened.turn.spaceId).toBe(origin.id)
  await expectHandleCount(window, 2)
  await navigateToWorkspaces(window)
  await workspaceCard(window, other.name).click()
  await expect(window.getByTitle(`Current workspace: ${other.name} — click to switch`, { exact: true })).toBeVisible()
  const deletion = await window.evaluate(({ spaceId, conversationId }) =>
    (globalThis as unknown as { halo: HaloAPI }).halo.deleteConversation(spaceId, conversationId), opened.turn)
  expect(deletion).toMatchObject({ success: true, data: true })
  await expect.poll(async () => (await livePages(window)).filter(page => page.spaceId === origin.id && page.released).map(page => page.viewId).sort()).toEqual([opened.controlViewId, opened.viewId].sort())
  expect(await guestIdentity(acceptanceApp.app, browserWorkSite.targetUrl)).toBe(opened.guestId)

  await navigateToWorkspaces(window)
  await openWorkspaceMenu(window, origin.name, 'Delete')
  await window.getByRole('alertdialog', { name: 'Delete this workspace?', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(workspaceCard(window, origin.name)).toHaveCount(0)
  await expect.poll(() => guestIdentity(acceptanceApp.app, browserWorkSite.targetUrl)).toBe(0)
  await expect.poll(() => guestIdentity(acceptanceApp.app, browserWorkSite.controlUrl)).toBe(0)
})
