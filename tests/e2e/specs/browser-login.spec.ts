import type { ElectronApplication } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, type LoginRequest } from '../fixtures/browser-login-site'
import { createBrowser, executeBrowser, destroyBrowser, guestIdentity } from '../fixtures/browser-site'
import { navigateToChat } from '../fixtures/helpers'
import { openFromHeaderMenu } from '../../perf/lib/open-artifact'

interface Identity { ua: string; brands: { brand: string; version: string }[]; halo?: string; node?: string }
const annotation = (caseId: string) => ({ type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'integration', mode: 'none', variant: {} }) })
async function contentsId(app: ElectronApplication, url: string): Promise<number> {
  return app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url)?.id ?? 0, url)
}
async function inspect<T>(app: ElectronApplication, id: number, code: string): Promise<T> {
  return app.evaluate(({ webContents }, { id, code }) => webContents.fromId(id)!.executeJavaScript(code), { id, code })
}
function assertIdentity(identity: Identity, major: string): void {
  expect(identity.ua).toMatch(new RegExp(`Chrome/${major}\\.`))
  expect(identity.ua).not.toMatch(/Electron\/|Halo\//i)
  expect(identity.brands.find(brand => brand.brand === 'Chromium')?.version).toBe(major)
}
function assertRequest(request: LoginRequest | undefined, ua: string, major: string): void {
  expect(request).toBeDefined()
  expect(request!.headers['user-agent']).toBe(ua)
  const brands = request!.headers['sec-ch-ua']
  if (brands) expect(brands).toContain(`"Chromium";v="${major}"`)
}

test('shares native browser identity and login storage without desktop privileges', { annotation: annotation('browser.login.identity') }, async ({ electronApp, window, loginSite }) => {
  const viewId = 'login-identity'
  await createBrowser(window, viewId, `${loginSite.origin}/parent`)
  const major = await electronApp.evaluate(() => process.versions.chrome.split('.')[0])
  const identity = await executeBrowser<Identity>(window, viewId, 'identity()')
  assertIdentity(identity, major)
  expect(identity).toMatchObject({ halo: 'undefined', node: 'undefined' })
  assertRequest(loginSite.requests.find(request => request.path === '/parent'), identity.ua, major)
  const worker = await executeBrowser<Identity>(window, viewId, 'workerIdentity()')
  assertIdentity(worker, major)
  expect(worker.ua).toBe(identity.ua)
  assertRequest(loginSite.requests.find(request => request.path === '/worker.js'), identity.ua, major)
  const result = await window.evaluate(async url => (window as unknown as { halo: HaloAPI }).halo.openLoginWindow(url), `${loginSite.origin}/login`)
  expect(result).toMatchObject({ success: true })
  await expect.poll(() => contentsId(electronApp, `${loginSite.origin}/login`)).toBeGreaterThan(0)
  const id = await contentsId(electronApp, `${loginSite.origin}/login`)
  await expect.poll(() => inspect<string>(electronApp, id, 'document.readyState')).toBe('complete')
  const login = await inspect<Identity>(electronApp, id, 'identity()')
  assertIdentity(login, major)
  expect(login).toEqual(identity)
  assertRequest(loginSite.requests.find(request => request.path === '/login'), identity.ua, major)
  await expect.poll(() => executeBrowser<string>(window, viewId, 'document.cookie')).toContain('login-fixture=shared')
  expect(await electronApp.evaluate(({ webContents, session }, id) => {
    const contents = webContents.fromId(id)!
    const preferences = (contents as typeof contents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences()
    return { sameSession: contents.session === session.fromPartition('persist:browser'), sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, webSecurity: preferences.webSecurity }
  }, id)).toEqual({ sameSession: true, sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true })

  for (const custom of ['Halo-browser-fixture/1.0', '']) {
    expect(await window.evaluate(async userAgent => {
      const api = (window as unknown as { halo: HaloAPI }).halo
      const config = await api.getConfig()
      if (!config.success || !config.data) throw new Error('Could not read the isolated configuration')
      const browser = (config.data as { browser?: Record<string, unknown> }).browser
      return api.setConfig({ browser: { ...browser, userAgent } })
    }, custom)).toMatchObject({ success: true })
    const expected = custom || identity.ua
    await expect.poll(() => executeBrowser<string>(window, viewId, 'navigator.userAgent')).toBe(expected)
    await expect.poll(() => inspect<string>(electronApp, id, 'navigator.userAgent')).toBe(expected)
    await expect.poll(() => executeBrowser<string>(window, viewId, 'document.readyState')).toBe('complete')
    expect((await executeBrowser<Identity>(window, viewId, 'workerIdentity()')).ua).toBe(expected)
    expect(loginSite.requests.filter(request => request.path === '/worker.js').at(-1)!.headers['user-agent']).toBe(expected)
    expect(loginSite.requests.filter(request => request.path === '/parent').at(-1)!.headers['user-agent']).toBe(expected)
    expect(loginSite.requests.filter(request => request.path === '/login').at(-1)!.headers['user-agent']).toBe(expected)
    expect(await executeBrowser<string>(window, viewId, 'document.cookie')).toContain('login-fixture=shared')
  }
  await destroyBrowser(window, viewId)
})

test('retains native OAuth popup requests, opener communication and child lifecycle', { annotation: annotation('browser.login.popup') }, async ({ electronApp, window, loginSite }) => {
  const viewId = 'login-popup'
  await createBrowser(window, viewId, `${loginSite.origin}/parent`)
  const parent = await executeBrowser(window, viewId, '({nonce:fixtureNonce,url:location.href,history:history.length})')
  const identity = await executeBrowser<Identity>(window, viewId, 'identity()')
  const major = await electronApp.evaluate(() => process.versions.chrome.split('.')[0])
  await executeBrowser(window, viewId, `(() => { const form=document.createElement('form'); form.method='POST';form.target='_blank';form.rel='opener';form.action='/callback';const field=document.createElement('input');field.name='fixture';field.value='synthetic-value';form.append(field);document.body.append(form);form.submit();return true; })()`)
  await expect.poll(() => contentsId(electronApp, `${loginSite.origin}/callback`)).toBeGreaterThan(0)
  const callback = await contentsId(electronApp, `${loginSite.origin}/callback`)
  await expect.poll(() => inspect<string>(electronApp, callback, 'document.readyState')).toBe('complete')
  const request = loginSite.requests.find(request => request.path === '/callback')
  assertRequest(request, identity.ua, major)
  expect(request).toMatchObject({ method: 'POST', body: 'fixture=synthetic-value' })
  expect(request!.headers['content-type']).toContain('application/x-www-form-urlencoded')
  expect(request!.headers.referer).toBe(`${loginSite.origin}/parent`)
  expect(await inspect<Identity>(electronApp, callback, 'identity()')).toEqual(identity)
  expect(await inspect(electronApp, callback, '!!opener')).toBe(true)
  await inspect(electronApp, callback, `opener.postMessage('synthetic-auth-complete',location.origin);true`)
  await expect.poll(() => executeBrowser(window, viewId, 'messages')).toEqual(['synthetic-auth-complete'])
  await inspect(electronApp, callback, 'setTimeout(()=>window.close(),0);true')
  await expect.poll(() => contentsId(electronApp, `${loginSite.origin}/callback`)).toBe(0)
  expect(await executeBrowser(window, viewId, '({nonce:fixtureNonce,url:location.href,history:history.length})')).toEqual(parent)

  await executeBrowser(window, viewId, `window.fixturePopup=window.open('about:blank','fixture-auth');fixturePopup.location.href='/blank-callback';true`)
  await expect.poll(() => contentsId(electronApp, `${loginSite.origin}/blank-callback`)).toBeGreaterThan(0)
  const blank = await contentsId(electronApp, `${loginSite.origin}/blank-callback`)
  expect(await inspect(electronApp, blank, '!!opener')).toBe(true)
  assertRequest(loginSite.requests.find(request => request.path === '/blank-callback'), identity.ua, major)
  await inspect(electronApp, blank, `window.open('/nested','fixture-nested');true`)
  await expect.poll(() => contentsId(electronApp, `${loginSite.origin}/nested`)).toBeGreaterThan(0)

  await executeBrowser(window, viewId, `(() => { const link=document.createElement('a');link.href='/link-popup';link.target='_blank';document.body.append(link);link.click();return true })()`)
  await expect.poll(() => contentsId(electronApp, `${loginSite.origin}/link-popup`)).toBeGreaterThan(0)
  const link = await contentsId(electronApp, `${loginSite.origin}/link-popup`)
  expect(await inspect(electronApp, link, 'opener === null')).toBe(true)
  assertRequest(loginSite.requests.find(request => request.path === '/link-popup'), identity.ua, major)

  await executeBrowser(window, viewId, `window.open('/no-opener','_blank','noopener');true`)
  await expect.poll(() => contentsId(electronApp, `${loginSite.origin}/no-opener`)).toBeGreaterThan(0)
  const detached = await contentsId(electronApp, `${loginSite.origin}/no-opener`)
  expect(await inspect(electronApp, detached, 'opener === null')).toBe(true)
  expect(await executeBrowser(window, viewId, '({nonce:fixtureNonce,url:location.href,history:history.length})')).toEqual(parent)
  await destroyBrowser(window, viewId)
  for (const route of ['/blank-callback', '/nested', '/no-opener', '/link-popup']) {
    await expect.poll(() => contentsId(electronApp, `${loginSite.origin}${route}`)).toBe(0)
  }
})

const compatibleDocument = { app: 'function', csi: 'function', loadTimes: 'function', node: 'undefined', halo: 'undefined' }

test('initializes page and dynamic cross-site frame capabilities before scripts and recovers after debugger detach', { annotation: annotation('browser.login.compatibility') }, async ({ electronApp, window, loginSite }) => {
  const viewId = 'compatibility-lifecycle'
  const url = `${loginSite.origin}/compatibility`
  await createBrowser(window, viewId, url)
  expect(await executeBrowser(window, viewId, 'initialCompatibility')).toEqual(compatibleDocument)
  const id = await contentsId(electronApp, url)
  for (const name of ['first', 'replacement']) {
    await executeBrowser(window, viewId, `(() => { document.querySelector('iframe')?.remove(); const frame=document.createElement('iframe');frame.src=${JSON.stringify(loginSite.origin.replace('127.0.0.1', 'localhost'))}+'/${name}';document.body.append(frame);return true })()`)
    await expect.poll(() => electronApp.evaluate(async ({ webContents }, { id, name }) => {
      const frame = webContents.fromId(id)!.mainFrame.framesInSubtree.find(frame => frame.url.endsWith('/' + name))
      return frame ? frame.executeJavaScript('window.initialCompatibility').catch(() => null) : null
    }, { id, name })).toEqual(compatibleDocument)
  }
  await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)!.debugger.detach(), id)
  const result = await window.evaluate(async ({ viewId, url }) => (window as unknown as { halo: HaloAPI }).halo.navigateBrowserView(viewId, url + '?recovered=1'), { viewId, url })
  expect(result.success).toBe(true)
  expect(await executeBrowser(window, viewId, 'initialCompatibility')).toEqual(compatibleDocument)
  await executeBrowser(window, viewId, `window.open('/early-popup','compatibility-popup');true`)
  await expect.poll(() => contentsId(electronApp, `${loginSite.origin}/early-popup`)).toBeGreaterThan(0)
  const popup = await contentsId(electronApp, `${loginSite.origin}/early-popup`)
  await expect.poll(() => inspect(electronApp, popup, 'initialCompatibility')).toEqual(compatibleDocument)
  await destroyBrowser(window, viewId)
  expect(await electronApp.evaluate(({ webContents }, id) => !!webContents.fromId(id), id)).toBe(false)
  await expect.poll(() => contentsId(electronApp, `${loginSite.origin}/early-popup`)).toBe(0)
})

test('opens ordinary links in Canvas tabs without an extra window or replacing the parent', { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'browser.login.tabs', evidence: 'app-e2e', mode: 'none', variant: {} }) } }, async ({ electronApp, window, loginSite }) => {
  test.setTimeout(60000)
  await navigateToChat(window)
  await openFromHeaderMenu(window, 'Open browser')
  const parentUrl = `${loginSite.origin}/parent`
  const address = window.getByPlaceholder(/Enter URL or search Bing/)
  await address.fill(parentUrl)
  await address.press('Enter')
  await expect.poll(() => guestIdentity(electronApp, parentUrl)).toBeGreaterThan(0)
  const parent = await guestIdentity(electronApp, parentUrl)
  const nonce = await inspect(electronApp, parent, 'fixtureNonce')
  const windows = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const clickLink = async (id: string) => {
    const guest = window.locator('webview[aria-hidden="false"]')
    await expect.poll(() => guest.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(100)
    const bounds = await guest.boundingBox()
    const rect = await inspect<{ x: number; y: number; width: number; height: number }>(electronApp, parent, `document.querySelector(${JSON.stringify(id)}).getBoundingClientRect().toJSON()`)
    await window.mouse.click(bounds!.x + rect.x + rect.width / 2, bounds!.y + rect.y + rect.height / 2)
  }
  await clickLink('#new-tab')
  const childUrl = `${loginSite.origin}/ordinary-tab`
  await expect.poll(() => guestIdentity(electronApp, childUrl)).toBeGreaterThan(0)
  await expect(window.locator('.canvas-tab')).toHaveCount(2)
  await expect(address).toHaveValue(childUrl)
  const child = await guestIdentity(electronApp, childUrl)
  expect(await inspect(electronApp, child, 'opener === null')).toBe(true)
  expect(loginSite.requests.filter(request => request.path === '/ordinary-tab')).toHaveLength(1)
  expect(loginSite.requests.find(request => request.path === '/ordinary-tab')!.headers.referer).toBe(parentUrl)
  expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windows)
  expect(await inspect(electronApp, parent, '({nonce:fixtureNonce,url:location.href})')).toEqual({ nonce, url: parentUrl })

  await window.locator('.canvas-tab').first().click()
  await expect(address).toHaveValue(parentUrl)
  await electronApp.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url)!.setSize(560, 800), window.url())
  await clickLink('#no-referrer')
  await expect(address).toHaveValue(`${loginSite.origin}/private-tab`)
  await expect(window.locator('.canvas-tab')).toHaveCount(3)
  expect(loginSite.requests.find(request => request.path === '/private-tab')!.headers.referer).toBeUndefined()
  expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windows)
  await window.locator('.canvas-tab').first().getByTitle('Close (⌘W / Middle-click)', { exact: true }).click()
  await expect(window.locator('.canvas-tab')).toHaveCount(2)
  expect(await inspect(electronApp, child, 'location.href')).toBe(childUrl)
  expect(await inspect(electronApp, child, 'initialCompatibility')).toEqual(compatibleDocument)
})
