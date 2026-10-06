import { createServer } from 'node:net'
import type { HaloAPI } from '../../../src/preload'
import { test, expect } from '../fixtures/electron-packaged'
import { navigateToChat } from '../fixtures/helpers'
import { createBrowser, showBrowser, hideBrowser, destroyBrowser, assertBrowserFrame } from '../fixtures/browser-site'

test.setTimeout(90000)

test('the packaged Electron 43 app starts and captures its persistent guest', async ({ electronApp, window, browserSite }) => {
  expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(true)
  expect(await electronApp.evaluate(() => process.versions.electron)).toMatch(/^43\./)
  await navigateToChat(window)
  const viewId = 'packaged-carrier'
  await createBrowser(window, viewId, browserSite.pageUrl(viewId))
  await showBrowser(window, viewId)
  await assertBrowserFrame(electronApp, window, viewId)
  await hideBrowser(window, viewId)
  await assertBrowserFrame(electronApp, window, viewId)
  await destroyBrowser(window, viewId)
})

test('the packaged HTTP server authenticates and renders the shared remote application', async ({ electronApp, window }) => {
  expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(true)
  await navigateToChat(window)
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  expect(await window.evaluate(async port => (window as unknown as { halo: HaloAPI }).halo.enableRemoteAccess(port), port)).toMatchObject({ success: true })
  const created = electronApp.waitForEvent('window')
  await electronApp.evaluate(async ({ BrowserWindow }, port) => {
    const remote = new BrowserWindow({ width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await remote.loadURL(`http://127.0.0.1:${port}`)
  }, port)
  const remote = await created
  try {
    await expect(remote.getByPlaceholder('Access Code', { exact: true })).toBeVisible()
    const token = await window.evaluate(async () => {
      const status = await (window as unknown as { halo: HaloAPI }).halo.getRemoteStatus()
      return (status.data as { server: { token: string } }).server.token
    })
    await remote.getByPlaceholder('Access Code', { exact: true }).fill(token)
    await remote.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(remote.locator('#root')).toBeVisible()
    await expect(remote.locator('nav button').first()).toBeVisible()
    expect(await remote.evaluate(() => typeof (window as unknown as { halo?: unknown }).halo)).toBe('undefined')
    await remote.getByRole('button', { name: 'Conversation', exact: true }).first().click()
    await expect(remote.locator('textarea')).toBeVisible()
  } finally {
    await remote.close()
    expect(await window.evaluate(async () => (window as unknown as { halo: HaloAPI }).halo.disableRemoteAccess())).toMatchObject({ success: true })
  }
})
