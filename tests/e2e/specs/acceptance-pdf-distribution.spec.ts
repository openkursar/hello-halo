import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const { PNG } = createRequire(import.meta.url)('pngjs') as { PNG: { sync: { read(bytes: Buffer): { width: number; height: number; data: Buffer } } } }

function nativePdfPixels(bytes: Buffer) {
  const image = PNG.sync.read(bytes)
  const palette = [[224, 24, 48], [16, 144, 80], [24, 96, 224], [232, 184, 16]]
  const colors = palette.map(() => ({ count: 0, x: 0, y: 0 }))
  let green = 0
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const index = (y * image.width + x) * 4
    for (let color = 0; color < palette.length; color++) if (palette[color].every((value, channel) => Math.abs(image.data[index + channel] - value) <= 3)) {
      colors[color].count++; colors[color].x += x; colors[color].y += y
    }
    if ([26, 179, 102].every((value, channel) => Math.abs(image.data[index + channel] - value) <= 3)) green++
  }
  return { width: image.width, height: image.height, green, colors: colors.map(color => ({ count: color.count, x: color.x / Math.max(1, color.count), y: color.y / Math.max(1, color.count) })) }
}
import { guestIdentity } from '../fixtures/browser-site'
import { cropPreviewFrame } from '../fixtures/acceptance-preview-formats'
import { test, expect } from '../fixtures/acceptance-remote-desktop'
import { managementAcceptance } from '../fixtures/acceptance-management'
import { assertPackagedWithoutNativeCanvas, distributionPdf, validateDistributionPdf } from '../fixtures/acceptance-pdf-distribution'
import { navigateToChat } from '../fixtures/helpers'
import { clickArtifactByName } from '../../perf/lib/open-artifact'

test.setTimeout(120000)

test('packaged halo-node runs the actual PDF creation and extraction libraries without native canvas', managementAcceptance('capabilities.skill-runtime.pdf-libraries'), async ({ managementApp }, info) => {
  const inventory = await assertPackagedWithoutNativeCanvas(managementApp.app)
  const script = join(managementApp.profile, 'pdf-runtime-check.cjs')
  writeFileSync(script, `const fs = require('node:fs');\n(async () => {\n const { PDFDocument, StandardFonts } = require('pdf-lib');\n const { getDocumentProxy, extractText } = require('unpdf');\n const doc = await PDFDocument.create();\n const font = await doc.embedFont(StandardFonts.Helvetica);\n doc.addPage().drawText('Office PDF runtime 87261345.25', { font });\n const bytes = await doc.save();\n fs.writeFileSync(process.argv[2], bytes);\n const parsed = await getDocumentProxy(bytes);\n try { const result = await extractText(parsed, { mergePages: true }); if (!result.text.includes('Office PDF runtime 87261345.25')) throw new Error('PDF extraction lost generated text'); console.log(JSON.stringify({ pages: parsed.numPages, text: result.text, pdfLib: require.resolve('pdf-lib'), unpdf: require.resolve('unpdf') })); } finally { await parsed.loadingTask.destroy(); }\n})().catch(error => { console.error(error); process.exitCode = 1; });\n`)
  const output = join(managementApp.profile, 'office-runtime-output.pdf')
  const result = await managementApp.app.evaluate(async ({ app }, input) => {
    const path = process.getBuiltinModule('node:path') as typeof import('node:path')
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const child = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
    const shim = path.join(app.getPath('userData'), 'office-runtime', 'bin', process.platform === 'win32' ? 'halo-node.cmd' : 'halo-node')
    if (!fs.existsSync(shim)) throw new Error('The application did not generate its actual halo-node shim')
    if (process.platform === 'win32') throw new Error('Windows cmd shim execution needs the controlled Git Bash fixture; no passing fallback is allowed')
    const env = { ...process.env, NODE_PATH: '', HOME: input.profile, USERPROFILE: input.profile }
    return await new Promise<string>((resolve, reject) => child.execFile(shim, [input.script, input.output], { env, cwd: input.profile, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`Actual office shim failed: ${error.message}; ${stderr}`)) : resolve(stdout)))
  }, { script, output, profile: managementApp.profile })
  const observation = JSON.parse(result.trim())
  expect(observation.pages).toBe(1)
  expect(observation.text).toContain('Office PDF runtime 87261345.25')
  expect(observation.pdfLib).toContain('office-runtime')
  expect(observation.unpdf).toContain('office-runtime')
  const { getDocumentProxy, extractText } = await import('unpdf')
  const parsed = await getDocumentProxy(new Uint8Array(readFileSync(output)))
  try { expect((await extractText(parsed, { mergePages: true })).text).toContain('Office PDF runtime 87261345.25') }
  finally { await parsed.destroy() }
  await info.attach('office-pdf-runtime', { body: JSON.stringify({ inventory, observation }, null, 2), contentType: 'application/json' })
})

test('packaged Chromium opens the complex two-page PDF without native canvas', managementAcceptance('files.preview.pdf-distribution', { viewer: 'desktop' }), async ({ managementApp, window }, info) => {
  const inventory = await assertPackagedWithoutNativeCanvas(managementApp.app)
  const document = distributionPdf()
  await validateDistributionPdf(document.bytes)
  const directory = join(managementApp.profile, '.halo', 'temp', 'artifacts')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, document.name)
  writeFileSync(file, document.bytes)
  await window.setViewportSize({ width: 1600, height: 1000 })
  await navigateToChat(window)
  await clickArtifactByName(window, document.name)
  const url = pathToFileURL(file).href
  await expect.poll(() => guestIdentity(managementApp.app, url)).toBeGreaterThan(0)
  const id = await guestIdentity(managementApp.app, url)
  const capture = async () => Buffer.from(await managementApp.app.evaluate(async ({ webContents }, id) => {
    const guest = webContents.fromId(id)
    if (!guest || guest.getType() !== 'webview') throw new Error('The PDF guest disappeared')
    return (await guest.capturePage()).toPNG().toString('base64')
  }, id), 'base64')
  const nativeControl = async (action: 'inspect' | 'next' | 'previous' | 'zoom') => managementApp.app.evaluate(async ({ webContents }, action) => {
    const frames = webContents.getAllWebContents().flatMap(contents => contents.mainFrame.framesInSubtree)
    for (const frame of frames) {
      const result = await frame.executeJavaScript(`(() => {
        const viewer = document.querySelector('pdf-viewer');
        if (!viewer) return null;
        const root = viewer.shadowRoot;
        const toolbar = root.querySelector('viewer-toolbar');
        if (!toolbar) return null;
        const toolbarRoot = toolbar.shadowRoot;
        const selector = toolbarRoot.querySelector('viewer-page-selector');
        const input = selector?.shadowRoot?.querySelector('input');
        const action = ${JSON.stringify(action)};
        if (action === 'next' || action === 'previous') {
          if (!input) throw new Error('Native PDF page input missing');
          input.value = action === 'next' ? '2' : '1';
          input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
        if (action === 'zoom') {
          const button = toolbarRoot.querySelector('#zoomIn');
          if (!button) throw new Error('Native PDF zoom control missing');
          button.click();
        }
        return { pageCount: toolbar.docLength, page: input?.value, zoom: toolbarRoot.querySelector('#zoom')?.value };
      })()`) as { pageCount: number; page?: string; zoom?: string } | null
      if (result) return result
    }
    throw new Error('The real native Chromium PDF controls were not found')
  }, action)
  await expect.poll(async () => (await nativeControl('inspect')).pageCount).toBe(2)
  await expect.poll(async () => nativePdfPixels(await capture()).colors.every(color => color.count > 100)).toBe(true)
  const visible = window.locator('webview[aria-hidden="false"]')
  await expect(visible).toHaveCount(1)
  await expect(visible).toBeVisible()
  await expect(visible).toHaveCSS('opacity', '1')
  await expect(visible).toBeInViewport()
  await expect.poll(async () => {
    const bounds = await visible.boundingBox()
    if (!bounds) return false
    const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    const crop = cropPreviewFrame(await window.screenshot(), viewport, bounds)
    return nativePdfPixels(crop.bytes).colors.every(color => color.count > 100)
  }).toBe(true)
  const firstBytes = await capture()
  const first = nativePdfPixels(firstBytes)
  expect(first.colors[0].x).toBeLessThan(first.colors[1].x)
  expect(first.colors[0].y).toBeLessThan(first.colors[2].y)
  await info.attach('desktop-pdf-first-page', { body: firstBytes, contentType: 'image/png' })
  await nativeControl('zoom')
  await expect.poll(async () => nativePdfPixels(await capture()).colors[0].count).toBeGreaterThan(first.colors[0].count)
  const zoomed = nativePdfPixels(await capture())
  await nativeControl('next')
  await expect.poll(async () => (await nativeControl('inspect')).page).toBe('2')
  await expect.poll(async () => nativePdfPixels(await capture()).green).toBeGreaterThan(1000)
  await info.attach('desktop-pdf-second-page', { body: await capture(), contentType: 'image/png' })
  await nativeControl('previous')
  await expect.poll(async () => nativePdfPixels(await capture()).colors.every(color => color.count > 100)).toBe(true)
  expect(readFileSync(file)).toEqual(document.bytes)
  await info.attach('desktop-pdf-observations', { body: JSON.stringify({ inventory, first, zoomed, boundary: 'Real native PDF toolbar DOM actions and guest pixels; Chinese glyph accuracy requires visual inspection of attached screenshot.' }, null, 2), contentType: 'application/json' })
  await info.attach('desktop-complex-pdf', { body: await window.screenshot(), contentType: 'image/png' })
})

test('packaged remote pdfjs paints Chinese, standard text and images then navigates and zooms without native canvas', managementAcceptance('files.preview.pdf-distribution', { viewer: 'remote' }), async ({ managementApp, remoteDesktop }, info) => {
  const inventory = await assertPackagedWithoutNativeCanvas(managementApp.app)
  const document = distributionPdf()
  const extracted = await validateDistributionPdf(document.bytes)
  const directory = join(managementApp.profile, '.halo', 'temp', 'artifacts')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, document.name)
  writeFileSync(file, document.bytes)
  const { page } = remoteDesktop
  const assets: Array<{ path: string; status: number }> = []
  const consoleMessages: Array<{ type: string; text: string }> = []
  page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text() }))
  page.on('pageerror', error => consoleMessages.push({ type: 'pageerror', text: error.message }))
  page.on('requestfailed', request => consoleMessages.push({ type: 'requestfailed', text: `${new URL(request.url()).pathname}: ${request.failure()?.errorText}` }))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname.includes('/pdfjs/')) assets.push({ path: url.pathname, status: response.status() })
  })
  await remoteDesktop.login()
  await navigateToChat(page)
  await clickArtifactByName(page, document.name)
  await expect(page.locator('.canvas-tab.active')).toContainText(document.name)
  const canvas = page.locator('canvas').last()
  await expect(canvas).toBeVisible()
  const pixels = async () => canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement
    const context = canvas.getContext('2d')!
    const sample = (left: number, top: number, right: number, bottom: number) => {
      const x = Math.floor(left * canvas.width), y = Math.floor(top * canvas.height)
      const width = Math.max(1, Math.floor((right - left) * canvas.width)), height = Math.max(1, Math.floor((bottom - top) * canvas.height))
      const data = context.getImageData(x, y, width, height).data
      let dark = 0, colored = 0
      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] && Math.max(data[index], data[index + 1], data[index + 2]) < 160) dark++
        if (data[index + 3] && Math.max(data[index], data[index + 1], data[index + 2]) - Math.min(data[index], data[index + 1], data[index + 2]) > 80) colored++
      }
      return { dark, colored }
    }
    return { width: canvas.width, height: canvas.height, bounds: canvas.getBoundingClientRect().toJSON(), parentBounds: canvas.parentElement?.getBoundingClientRect().toJSON(), latin: sample(.08, .08, .9, .15), chinese: sample(.08, .18, .5, .27), image: sample(.08, .38, .4, .7) }
  })
  try {
    await expect.poll(async () => {
      const value = await pixels()
      return value.latin.dark > 100 && value.chinese.dark > 100 && value.image.colored > 1000
    }, { timeout: 30000 }).toBe(true)
  } finally {
    await info.attach('remote-pdf-render-diagnostics', { body: JSON.stringify({ pixels: await pixels(), assets, consoleMessages }, null, 2), contentType: 'application/json' })
    await info.attach('remote-pdf-rendered-canvas', { body: await canvas.screenshot(), contentType: 'image/png' })
  }
  const first = await pixels()
  await expect(page.getByTitle('Previous page', { exact: true })).toBeDisabled()
  await expect.poll(() => assets.some(asset => asset.path.includes('/cmaps/') && asset.status === 200)).toBe(true)
  await expect.poll(() => assets.some(asset => asset.path.includes('/standard_fonts/') && asset.status === 200)).toBe(true)
  await info.attach('remote-pdf-first-page', { body: await canvas.screenshot(), contentType: 'image/png' })
  await page.getByTitle('Next page', { exact: true }).click()
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible()
  await expect(page.getByTitle('Next page', { exact: true })).toBeDisabled()
  await expect.poll(async () => (await pixels()).chinese.dark).toBe(0)
  await page.getByTitle('Zoom in', { exact: true }).click()
  await expect(page.getByText('125%', { exact: true })).toBeVisible()
  await expect.poll(async () => (await pixels()).width).toBeGreaterThan(first.width)
  await page.getByTitle('Fit width', { exact: true }).click()
  await expect.poll(async () => (await pixels()).width).toBe(first.width)
  await page.getByTitle('Previous page', { exact: true }).click()
  await expect(page.getByText('1 / 2', { exact: true })).toBeVisible()
  await expect.poll(async () => (await pixels()).chinese.dark).toBeGreaterThan(100)
  expect(readFileSync(file)).toEqual(document.bytes)
  expect(assets.filter(asset => asset.status !== 200)).toEqual([])
  await info.attach('pdf-distribution-observations', { body: JSON.stringify({ inventory, extracted, first, assets, boundary: 'Real packaged HTTP session and frontend; region ink checks are not a glyph-accuracy OCR oracle.' }, null, 2), contentType: 'application/json' })
})
