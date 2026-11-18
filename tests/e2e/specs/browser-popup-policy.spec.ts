import { createServer } from 'node:http'
import type { ElectronApplication } from '@playwright/test'
import { test as base, expect, callBrowserTool } from '../fixtures/browser-runtime'
import { executeBrowser, destroyBrowser } from '../fixtures/browser-site'

const test = base.extend<{ popupSite: { origin: string; denied: string[]; seen: string[] } }>({
  popupSite: async ({}, use) => {
    const denied: string[] = [], seen: string[] = []
    const server = createServer((request, response) => {
      const route = new URL(request.url!, 'http://localhost').pathname
      if (request.headers.host?.startsWith('localhost:') && route !== '/health') denied.push(route)
      seen.push(route)
      response.setHeader('cache-control', 'no-store')
      if (route === '/redirect') {
        response.writeHead(302, { location: `http://localhost:${(server.address() as { port: number }).port}/denied-redirect` })
        response.end()
        return
      }
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html><title>Popup policy fixture</title><script>window.nonce=crypto.randomUUID();${route === '/script' ? `location.href='http://localhost:${(server.address() as { port: number }).port}/denied-script';` : ''}</script><h1>Popup policy fixture</h1>`)
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      expect((await fetch(origin.replace('127.0.0.1', 'localhost') + '/health')).ok).toBe(true)
      await use({ origin, denied, seen })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  },
})
const annotation = (caseId: string) => ({ type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'integration', mode: 'none', variant: {} }) })
async function childId(app: ElectronApplication, url: string) {
  return app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url)?.webContents.id ?? 0, url)
}

test.describe('native popup policy', () => {
  test.use({ browserPolicy: { mode: 'allowlist', allowlist: ['127.0.0.1'], userExtensible: false } })
  test('blocks popup redirects and retargeting while native links load without replacing their parent', { annotation: annotation('browser.login.policy') }, async ({ electronApp, window, popupSite }) => {
    const opened = await callBrowserTool(window, 'main', 'browser_navigate', { url: `${popupSite.origin}/parent` })
    const viewId = opened.viewId!
    const parent = await executeBrowser(window, viewId, '({nonce,url:location.href,history:history.length})')
    await electronApp.evaluate(({ app }) => {
      const state = globalThis as unknown as { popupBlocked: number }
      state.popupBlocked = 0
      app.on('web-contents-created', (_event, contents) => {
        const record = (event: Electron.Event, url: string) => {
          if (url.startsWith('http://localhost:')) setImmediate(() => { if (event.defaultPrevented) state.popupBlocked++ })
        }
        contents.on('will-navigate', record)
        contents.on('will-redirect', record)
      })
    })
    const blockedCount = () => electronApp.evaluate(() => (globalThis as unknown as { popupBlocked: number }).popupBlocked)
    await executeBrowser(window, viewId, `window.open('/redirect','redirect');true`)
    await expect.poll(() => popupSite.seen.includes('/redirect')).toBe(true)
    await expect.poll(blockedCount).toBeGreaterThanOrEqual(1)
    await executeBrowser(window, viewId, `window.open('/script','script');true`)
    await expect.poll(blockedCount).toBeGreaterThanOrEqual(2)
    await executeBrowser(window, viewId, `window.namedPopup=window.open('/named','named-popup');true`)
    await expect.poll(() => childId(electronApp, `${popupSite.origin}/named`)).toBeGreaterThan(0)
    const deniedUrl = popupSite.origin.replace('127.0.0.1', 'localhost') + '/denied-named'
    await executeBrowser(window, viewId, `window.open(${JSON.stringify(deniedUrl)},'named-popup');true`)
    await expect.poll(blockedCount).toBeGreaterThanOrEqual(3)
    await executeBrowser(window, viewId, `window.blankPopup=window.open('about:blank','blank-popup');blankPopup.location.href=${JSON.stringify(deniedUrl + '-blank')};true`)
    await expect.poll(blockedCount).toBeGreaterThanOrEqual(4)
    await executeBrowser(window, viewId, `(()=>{const link=document.createElement('a');link.href='/native-link';link.target='_blank';document.body.append(link);link.click();return true})()`)
    await expect.poll(() => childId(electronApp, `${popupSite.origin}/native-link`)).toBeGreaterThan(0)
    expect(popupSite.seen).toContain('/native-link')
    expect(popupSite.denied).toEqual([])
    expect(await executeBrowser(window, viewId, '({nonce,url:location.href,history:history.length})')).toEqual(parent)
    await destroyBrowser(window, viewId)
  })
})

test('keeps automation popups hidden and releases descendants when their opener closes', { annotation: annotation('browser.login.hidden') }, async ({ electronApp, window, popupSite }) => {
  const opened = await callBrowserTool(window, 'automation', 'browser_navigate', { url: `${popupSite.origin}/automation` })
  const viewId = opened.viewId!
  const focused = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null)
  await executeBrowser(window, viewId, `window.open('/hidden-child','hidden-child');true`)
  await expect.poll(() => childId(electronApp, `${popupSite.origin}/hidden-child`)).toBeGreaterThan(0)
  const id = await childId(electronApp, `${popupSite.origin}/hidden-child`)
  await electronApp.evaluate(async ({ webContents }, id) => { await webContents.fromId(id)!.executeJavaScript(`window.open('/hidden-nested','hidden-nested');true`) }, id)
  await expect.poll(() => childId(electronApp, `${popupSite.origin}/hidden-nested`)).toBeGreaterThan(0)
  const windows = await electronApp.evaluate(({ BrowserWindow }, origin) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().startsWith(origin + '/hidden-')).map(window => ({ visible: window.isVisible(), focused: window.isFocused() })), popupSite.origin)
  expect(windows).toEqual([{ visible: false, focused: false }, { visible: false, focused: false }])
  expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null)).toBe(focused)
  await destroyBrowser(window, viewId)
  for (const route of ['/hidden-child', '/hidden-nested']) await expect.poll(() => childId(electronApp, popupSite.origin + route)).toBe(0)
})
