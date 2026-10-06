import { createServer } from 'node:http'
import type { ElectronApplication, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { test as base, expect } from './electron'
import { waitForHomePage } from './helpers'

const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Carrier regression page</title></head>
<body style="margin:0;background:#00b4ff;min-height:2400px;font:20px sans-serif">
<h1>Carrier regression page</h1><form id="form"><label>Draft <input id="draft" aria-label="Draft"></label></form>
<button id="action">Page action</button><input type="file" id="upload" aria-label="Upload">
<a href="/download" download="carrier.txt">Download</a><a href="/popup" target="_blank">Popup</a>
<output id="clicks">0</output><script>
window.carrierNonce = crypto.randomUUID(); window.pageClicks = 0; window.ticks = 0;
window.submitted = 0; document.querySelector('#form').addEventListener('submit', event => { event.preventDefault(); window.submitted++ });
document.addEventListener('click', () => document.querySelector('#clicks').textContent = String(++window.pageClicks));
setInterval(() => window.ticks++, 100);
</script></body></html>`

export function browserHtmlFixture(): string { return PAGE }

export function browserPdfFixture(): Buffer {
  const content = 'BT /F1 24 Tf 40 200 Td (Carrier PDF regression) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 280] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

interface BrowserSite {
  origin: string
  pageUrl: (name: string) => string
}

export const test = base.extend<{ browserSite: BrowserSite }>({
  browserSite: async ({}, use) => {
    const server = createServer((request, response) => {
      if (request.url?.startsWith('/inspect-api')) {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('Carrier inspection data')
        return
      }
      if (request.url?.startsWith('/redirect')) {
        const target = new URL(request.url, 'http://127.0.0.1').searchParams.get('target')!
        response.writeHead(302, { location: target })
        response.end()
        return
      }
      if (request.url?.startsWith('/document.pdf')) {
        response.writeHead(200, { 'content-type': 'application/pdf' })
        response.end(browserPdfFixture())
        return
      }
      if (request.url?.startsWith('/download')) {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="carrier.txt"' })
        response.end('Carrier download fixture\n')
        return
      }
      if (request.url?.startsWith('/login')) response.setHeader('set-cookie', 'carrier-login=shared; Path=/; SameSite=Lax')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(PAGE)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Browser fixture server has no TCP address')
    const origin = `http://127.0.0.1:${address.port}`
    try {
      await use({ origin, pageUrl: name => `${origin}/page?case=${encodeURIComponent(name)}` })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
})

export { expect }

export const BROWSER_BOUNDS = { x: 240, y: 100, width: 640, height: 480 }

export async function createBrowser(window: Page, viewId: string, url: string): Promise<void> {
  await waitForHomePage(window)
  const result = await window.evaluate(async ({ viewId, url }) =>
    (window as unknown as { halo: HaloAPI }).halo.createBrowserView(viewId, url), { viewId, url })
  expect(result, 'production browser:create must succeed').toMatchObject({ success: true })
  await expect.poll(() => executeBrowser(window, viewId, 'location.href')).toBe(url)
  await expect.poll(() => executeBrowser(window, viewId, 'document.readyState')).toBe('complete')
}

export async function showBrowser(window: Page, viewId: string, bounds = BROWSER_BOUNDS): Promise<void> {
  const result = await window.evaluate(async ({ viewId, bounds }) =>
    (window as unknown as { halo: HaloAPI }).halo.showBrowserView(viewId, bounds), { viewId, bounds })
  expect(result, 'production browser:show must succeed').toMatchObject({ success: true })
  await window.waitForFunction(viewId => Array.from(document.querySelectorAll('webview')).some(element => (element as HTMLElement).dataset.browserPageId === viewId && element.getAttribute('aria-hidden') === 'false'), viewId)
  await window.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

export async function hideBrowser(window: Page, viewId: string): Promise<void> {
  const result = await window.evaluate(async viewId =>
    (window as unknown as { halo: HaloAPI }).halo.hideBrowserView(viewId), viewId)
  expect(result, 'production browser:hide must succeed').toMatchObject({ success: true })
}

export async function destroyBrowser(window: Page, viewId: string): Promise<void> {
  const result = await window.evaluate(async viewId =>
    (window as unknown as { halo: HaloAPI }).halo.destroyBrowserView(viewId), viewId)
  expect(result, 'production browser:destroy must succeed').toMatchObject({ success: true })
}

export async function executeBrowser<T = unknown>(window: Page, viewId: string, code: string): Promise<T> {
  const result = await window.evaluate(async ({ viewId, code }) =>
    (window as unknown as { halo: HaloAPI }).halo.executeBrowserJS(viewId, code), { viewId, code })
  expect(result, 'production browser:execute-js must succeed').toMatchObject({ success: true })
  return result.data as T
}

export async function guestIdentity(app: ElectronApplication, url: string): Promise<number> {
  return app.evaluate(({ webContents }, url) => {
    const canonical = (value: string) => value.replace(/^file:\/\/\/private\/var\//, 'file:///var/')
    const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && canonical(contents.getURL()) === canonical(url))
    return guest?.id ?? 0
  }, url)
}

export async function assertBrowserFrame(app: ElectronApplication, window: Page, viewId: string): Promise<void> {
  const result = await window.evaluate(async viewId => Promise.race([
    (window as unknown as { halo: HaloAPI }).halo.captureBrowserView(viewId),
    new Promise<{ success: false; error: string; data?: unknown }>(resolve => setTimeout(() => resolve({ success: false, error: 'browser:capture did not settle within 8 seconds' }), 8000)),
  ]), viewId)
  const geometry = await window.evaluate(() => Array.from(document.querySelectorAll('webview')).map(element => {
    const style = getComputedStyle(element)
    const guest = element as HTMLElement & { getWebContentsId: () => number }
    return { id: guest.dataset.browserPageId, webContentsId: guest.getWebContentsId(), rect: element.getBoundingClientRect().toJSON(), shadowFrame: element.shadowRoot?.querySelector('iframe')?.getBoundingClientRect().toJSON(), style: { display: style.display, visibility: style.visibility, left: style.left, top: style.top }, hidden: element.getAttribute('aria-hidden') }
  }))
  let diagnostics: unknown
  if (typeof result.data !== 'string') {
    diagnostics = await app.evaluate(async ({ webContents }, id) => {
      const guest = webContents.fromId(id)!
      const probes: unknown[] = []
      const captures = [() => guest.capturePage(), () => guest.capturePage({} as Electron.Rectangle, { stayHidden: true, stayAwake: true }), () => guest.capturePage(undefined, { stayHidden: true, stayAwake: true })]
      for (const capture of captures) {
        try {
          probes.push(await Promise.race([capture().then(image => ({ empty: image.isEmpty(), size: image.getSize() })), new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1500))]))
        } catch (error) { probes.push({ error: error instanceof Error ? error.message : String(error) }) }
      }
      const viewport = await guest.executeJavaScript('({ width: innerWidth, height: innerHeight, visibility: document.visibilityState })')
      if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
      const cdp: unknown[] = []
      for (const fromSurface of [true, false]) {
        try {
          cdp.push(await Promise.race([guest.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface }).then(result => ({ fromSurface, bytes: result.data.length })), new Promise(resolve => setTimeout(() => resolve({ fromSurface, timeout: true }), 1500))]))
        } catch (error) { cdp.push({ fromSurface, error: error instanceof Error ? error.message : String(error) }) }
      }
      return { id, url: guest.getURL(), destroyed: guest.isDestroyed(), loading: guest.isLoading(), processId: guest.mainFrame.processId, viewport, probes, cdp }
    }, geometry.find(entry => entry.id === viewId)!.webContentsId)
  }
  expect(typeof result.data, `capture ${viewId}: ${JSON.stringify(result)}, host geometry ${JSON.stringify(geometry)}, native probes ${JSON.stringify(diagnostics)}`).toBe('string')
  const painted = await app.evaluate(({ nativeImage }, data) => {
    const image = nativeImage.createFromDataURL(data)
    const bitmap = image.toBitmap()
    let bluePixels = 0
    for (let i = 0; i < bitmap.length; i += 4) {
      if (bitmap[i] > 200 && bitmap[i + 1] > 120 && bitmap[i + 2] < 40) bluePixels++
    }
    return { ...image.getSize(), bluePixels }
  }, result.data as string)
  expect(painted.width).toBeGreaterThan(100)
  expect(painted.height).toBeGreaterThan(100)
  expect(painted.bluePixels, 'capture must contain the page, not an empty compositor surface').toBeGreaterThan(10000)
}
