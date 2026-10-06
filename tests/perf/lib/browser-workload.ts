import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { fixturePath } from './fixture-store'
import type { CdpSnapshot } from './cdp-metrics'
import type { ProcessWindowStat } from './process-metrics'
import type { PerfResult } from '../types'
import { launchElectronApp } from '../../e2e/fixtures/electron'

export const BROWSER_PERF_BOUNDS = { x: 240, y: 100, width: 640, height: 480 }

export interface BrowserPerfFixture {
  url: string
  title: string
  elements: number
  bytes: number
  sha256: string
}

export interface BrowserPageEvidence {
  url: string
  readyState: string
  title: string
  elements: number
  nonce: string | null
  viewport: { width: number; height: number }
  contentsId: number
  pid: number
  type: string
}

export interface BrowserFrameEvidence {
  width: number
  height: number
  opaquePixels: number
  fullyOpaquePixels: number
  darkPixels: number
  lightPixels: number
  blankCorner: { x: number; y: number; width: number; height: number; pixels: number; whitePixels: number }
}

export interface BrowserRuntimeIdentity {
  electron: string
  chromium: string
  node: string
  appVersion: string
  mainBundleSha256: string
  logicalCores: number
  mainWindowPid: number
}

export interface BrowserResources {
  webContentsIds: number[]
  nativeBrowserViews: number | null
  windowCount: number
  mainWindowListeners: Record<string, number>
  mainWindowEvents: Record<string, number>
  appListeners: Record<string, number>
  domPages: number
}

export interface BrowserPerfResult extends PerfResult {
  browser: Record<string, unknown>
}

export interface BrowserPerfApp {
  app: ElectronApplication
  dispose(): Promise<void>
}

/** The same CJS entry installs GC instrumentation before either runtime loads its application. */
export async function launchBrowserPerfApp(appEntryPath: string, profile: string): Promise<BrowserPerfApp> {
  if (process.env.HALO_E2E_PACKAGED_APP) throw new Error('Browser performance GC instrumentation requires the built CJS entry')
  const token = randomUUID()
  const wrapper = join(dirname(appEntryPath), `.browser-perf-launch-${token}.cjs`)
  writeFileSync(wrapper, `const v8 = require('node:v8');
const vm = require('node:vm');
v8.setFlagsFromString('--expose_gc');
const collect = vm.runInNewContext('gc');
if (typeof collect !== 'function') throw new Error('Browser performance GC function is unavailable');
globalThis.__browserPerfCollectMainHeapToken = ${JSON.stringify(token)};
globalThis.__browserPerfCollectMainHeap = () => { collect(); return v8.getHeapStatistics().used_heap_size / 1048576; };
require(${JSON.stringify(appEntryPath)});
`, { mode: 0o600 })
  let app: ElectronApplication
  try { app = await launchElectronApp(wrapper, profile) }
  catch (error) { rmSync(wrapper, { force: true }); throw error }
  let disposed = false
  return {
    app,
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        if (app.process().exitCode === null && app.process().signalCode === null) {
          try {
            await boundedBrowserCall(app.evaluate((_electron, token) => {
              const state = globalThis as unknown as { __browserPerfCollectMainHeapToken?: string; __browserPerfCollectMainHeap?: () => number }
              if (state.__browserPerfCollectMainHeapToken !== token) throw new Error('Browser performance GC ownership changed')
              delete state.__browserPerfCollectMainHeap
              delete state.__browserPerfCollectMainHeapToken
            }, token))
          } catch (error) {
            if (app.process().exitCode === null && app.process().signalCode === null) console.warn('[BrowserPerf] GC instrumentation cleanup failed', error)
          }
          await app.close()
        }
      } finally { rmSync(wrapper, { force: true }) }
    },
  }
}

async function boundedBrowserCall<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([request, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Browser performance IPC exceeded 30 seconds')), 30000)
    })])
  } finally { clearTimeout(timer) }
}

/** Both carriers render identical bytes; readiness never depends on the default homepage. */
export async function createBrowserPerfSite() {
  const heavy = readFileSync(fixturePath('html-extreme-2mb.html'))
  const cycle = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Browser cycle fixture</title></head>
<body style="font:18px sans-serif;background:white;color:black;margin:16px"><h1>Browser cycle fixture</h1>
${Array.from({ length: 80 }, (_, index) => `<p data-row="${index}">Browser row ${index}: a fixed local rendering workload.</p>`).join('\n')}
<script>window.browserPerfNonce = crypto.randomUUID()</script></body></html>`)
  const files = new Map([['/heavy.html', heavy], ['/cycle.html', cycle]])
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const bytes = files.get(pathname)
    if (!bytes) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(bytes)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Browser performance fixture has no TCP address')
  const origin = `http://127.0.0.1:${address.port}`
  const fixture = (pathname: string, query = ''): BrowserPerfFixture => {
    const bytes = files.get(pathname)!
    const source = bytes.toString('utf-8')
    return {
      url: `${origin}${pathname}${query}`,
      title: source.match(/<title>([^<]+)<\/title>/)![1],
      elements: [...source.matchAll(/<[a-z][a-z0-9]*(?=[\s>])/gi)].length,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  return {
    origin,
    heavy: fixture('/heavy.html'),
    cycle: (name: string) => fixture('/cycle.html', `?page=${encodeURIComponent(name)}`),
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

export async function readBrowserRuntime(app: ElectronApplication, mainPath: string): Promise<BrowserRuntimeIdentity> {
  const mainBundleSha256 = createHash('sha256').update(readFileSync(mainPath)).digest('hex')
  const runtime = await app.evaluate(({ app, BrowserWindow }, logicalCores) => {
    const mainWindow = BrowserWindow.getAllWindows().find(window => window.isVisible())
    if (!mainWindow) throw new Error('Browser performance run has no visible main window')
    const electron = process.versions.electron
    const chromium = process.versions.chrome
    if (!electron || !chromium) throw new Error('Browser performance runtime version was not collected')
    return {
      electron,
      chromium,
      node: process.versions.node,
      appVersion: app.getVersion(),
      logicalCores,
      mainWindowPid: mainWindow.webContents.getOSProcessId(),
    }
  }, cpus().length)
  if (process.env.PERF_EXPECT_ELECTRON_MAJOR) expect(runtime.electron.split('.')[0], 'actual running Electron major matches the comparison arm').toBe(process.env.PERF_EXPECT_ELECTRON_MAJOR)
  return { ...runtime, mainBundleSha256 }
}

export async function executeBrowserPerf<T>(window: Page, viewId: string, code: string): Promise<T> {
  const response = await boundedBrowserCall(window.evaluate(async ({ viewId, code }) =>
    (window as unknown as { halo: HaloAPI }).halo.executeBrowserJS(viewId, code), { viewId, code }))
  expect(response, 'production browser:execute-js must succeed').toMatchObject({ success: true })
  return response.data as T
}

export async function showBrowserPerf(window: Page, viewId: string): Promise<void> {
  const response = await boundedBrowserCall(window.evaluate(async ({ viewId, bounds }) =>
    (window as unknown as { halo: HaloAPI }).halo.showBrowserView(viewId, bounds), { viewId, bounds: BROWSER_PERF_BOUNDS }))
  expect(response, 'production browser:show must succeed').toMatchObject({ success: true })
}

export async function parkBrowserPerf(window: Page, viewId: string): Promise<void> {
  const response = await boundedBrowserCall(window.evaluate(async viewId =>
    (window as unknown as { halo: HaloAPI }).halo.hideBrowserView(viewId), viewId))
  expect(response, 'production browser:hide must succeed').toMatchObject({ success: true })
}

export async function createBrowserPerfPage(app: ElectronApplication, window: Page, viewId: string, fixture: BrowserPerfFixture): Promise<BrowserPageEvidence> {
  const response = await boundedBrowserCall(window.evaluate(async ({ viewId, url }) =>
    (window as unknown as { halo: HaloAPI }).halo.createBrowserView(viewId, url), { viewId, url: fixture.url }))
  expect(response, 'production browser:create must succeed').toMatchObject({ success: true })
  await showBrowserPerf(window, viewId)
  await expect.poll(() => executeBrowserPerf(window, viewId, '({url:location.href,readyState:document.readyState,title:document.title,elements:document.querySelectorAll("*").length,viewport:{width:innerWidth,height:innerHeight}})'), { timeout: 30000, intervals: [25, 50, 100] })
    .toEqual({ url: fixture.url, readyState: 'complete', title: fixture.title, elements: fixture.elements, viewport: { width: BROWSER_PERF_BOUNDS.width, height: BROWSER_PERF_BOUNDS.height } })
  const page = await executeBrowserPerf<Omit<BrowserPageEvidence, 'contentsId' | 'pid' | 'type'>>(window, viewId,
    '({url:location.href,readyState:document.readyState,title:document.title,elements:document.querySelectorAll("*").length,nonce:window.browserPerfNonce ?? null,viewport:{width:innerWidth,height:innerHeight}})')
  const identity = await app.evaluate(({ webContents }, url) => {
    const guests = webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && contents.getURL() === url)
    if (guests.length !== 1) throw new Error(`Expected one browser workload guest, found ${guests.length}`)
    const contents = guests[0]
    const state = globalThis as unknown as { __browserPerf?: { crashes: number; unresponsive: number; navigations: number } }
    state.__browserPerf ??= { crashes: 0, unresponsive: 0, navigations: 0 }
    contents.once('render-process-gone', (_event, details) => { if (details.reason !== 'clean-exit') state.__browserPerf!.crashes++ })
    contents.on('unresponsive', () => { state.__browserPerf!.unresponsive++ })
    contents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) state.__browserPerf!.navigations++ })
    return { contentsId: contents.id, pid: contents.getOSProcessId(), type: contents.getType() }
  }, fixture.url)
  expect(identity.pid).toBeGreaterThan(0)
  return { ...page, ...identity }
}

/** Verify real page pixels, rather than accepting an empty image or a success envelope. */
export async function captureBrowserPerf(app: ElectronApplication, window: Page, viewId: string): Promise<BrowserFrameEvidence> {
  const response = await window.evaluate(async viewId => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (window as unknown as { halo: HaloAPI }).halo.captureBrowserView(viewId),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Browser performance capture exceeded 15 seconds')), 15000) }),
      ])
    } finally { clearTimeout(timer) }
  }, viewId)
  expect(response, 'production browser:capture must succeed').toMatchObject({ success: true })
  expect(typeof response.data).toBe('string')
  const pixels = await app.evaluate(({ nativeImage }, data) => {
    const image = nativeImage.createFromDataURL(data)
    if (image.isEmpty()) throw new Error('Browser performance capture returned an empty image')
    const bitmap = image.toBitmap()
    let opaquePixels = 0
    let fullyOpaquePixels = 0
    let darkPixels = 0
    let lightPixels = 0
    for (let index = 0; index < bitmap.length; index += 4) {
      if (bitmap[index + 3] === 0) continue
      opaquePixels++
      if (bitmap[index + 3] === 255) fullyOpaquePixels++
      if (Math.max(bitmap[index], bitmap[index + 1], bitmap[index + 2]) < 120) darkPixels++
      if (Math.min(bitmap[index], bitmap[index + 1], bitmap[index + 2]) > 220) lightPixels++
    }
    const size = image.getSize()
    const blankCorner = { x: 0, y: 0, width: 4, height: 4, pixels: 16, whitePixels: 0 }
    for (let y = 0; y < blankCorner.height; y++) {
      for (let x = 0; x < blankCorner.width; x++) {
        const index = (y * size.width + x) * 4
        if (bitmap[index] === 255 && bitmap[index + 1] === 255 && bitmap[index + 2] === 255 && bitmap[index + 3] === 255) blankCorner.whitePixels++
      }
    }
    return { ...size, opaquePixels, fullyOpaquePixels, darkPixels, lightPixels, blankCorner }
  }, response.data as string)
  expect(pixels.width).toBeGreaterThanOrEqual(320)
  expect(pixels.height).toBeGreaterThanOrEqual(240)
  expect(pixels.opaquePixels).toBeGreaterThan(10000)
  expect(pixels.darkPixels, 'fixture text must paint').toBeGreaterThan(100)
  expect(pixels.lightPixels, 'fixture background must paint').toBeGreaterThan(10000)
  return pixels
}

export async function browserGuestSnapshot(app: ElectronApplication, contentsId: number): Promise<CdpSnapshot> {
  return app.evaluate(async ({ webContents }, contentsId) => {
    const contents = webContents.fromId(contentsId)
    if (!contents || contents.isDestroyed()) throw new Error('Browser performance guest disappeared before collection')
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    await contents.debugger.sendCommand('Performance.enable')
    await contents.debugger.sendCommand('Runtime.discardConsoleEntries')
    await contents.debugger.sendCommand('HeapProfiler.collectGarbage')
    const { metrics } = await contents.debugger.sendCommand('Performance.getMetrics') as { metrics: Array<{ name: string; value: number }> }
    const values = new Map(metrics.map(metric => [metric.name, metric.value]))
    for (const name of ['JSHeapUsedSize', 'Nodes', 'JSEventListeners', 'LayoutCount', 'RecalcStyleCount']) {
      if (!values.has(name)) throw new Error(`Browser guest metric ${name} was not collected`)
    }
    return { heapMB: values.get('JSHeapUsedSize')! / 1048576, nodes: values.get('Nodes')!, listeners: values.get('JSEventListeners')!, layoutCount: values.get('LayoutCount')!, recalcStyleCount: values.get('RecalcStyleCount')! }
  }, contentsId)
}

export async function readBrowserResources(app: ElectronApplication, window: Page): Promise<BrowserResources> {
  const native = await app.evaluate(({ app, BrowserWindow, webContents }) => {
    const windows = BrowserWindow.getAllWindows()
    const mainWindow = windows.find(window => window.isVisible())
    if (!mainWindow) throw new Error('Main window disappeared during browser resource collection')
    const withViews = mainWindow as Electron.BrowserWindow & { getBrowserViews?: () => unknown[] }
    const listeners = (emitter: { eventNames: () => Array<string | symbol>; listenerCount: (event: string | symbol) => number }) =>
      Object.fromEntries(emitter.eventNames().map(event => [String(event), emitter.listenerCount(event)]))
    return {
      webContentsIds: webContents.getAllWebContents().filter(contents => !contents.isDestroyed()).map(contents => contents.id).sort((a, b) => a - b),
      nativeBrowserViews: typeof withViews.getBrowserViews === 'function' ? withViews.getBrowserViews().length : null,
      windowCount: windows.length,
      mainWindowListeners: listeners(mainWindow.webContents),
      mainWindowEvents: listeners(mainWindow),
      appListeners: listeners(app),
    }
  })
  const domPages = await window.locator('webview[data-browser-page-id]').count()
  return { ...native, domPages }
}

export async function closeBrowserPerfPage(app: ElectronApplication, window: Page, viewId: string, contentsId: number): Promise<void> {
  const response = await boundedBrowserCall(window.evaluate(async viewId =>
    (window as unknown as { halo: HaloAPI }).halo.destroyBrowserView(viewId), viewId))
  expect(response, 'production browser:destroy must succeed').toMatchObject({ success: true })
  await expect.poll(async () => {
    const state = await window.evaluate(async viewId => (window as unknown as { halo: HaloAPI }).halo.getBrowserState(viewId), viewId)
    expect(state).toMatchObject({ success: true })
    const nativeAlive = await app.evaluate(({ webContents }, id) => !!webContents.fromId(id), contentsId)
    const domAlive = await window.locator(`webview[data-browser-page-id="${viewId}"]`).count()
    return { state: state.data, nativeAlive, domAlive }
  }, { timeout: 10000, intervals: [16, 50, 100] }).toEqual({ state: null, nativeAlive: false, domAlive: 0 })
}

export async function collectMainHeap(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => {
    const collect = (globalThis as unknown as { __browserPerfCollectMainHeap?: () => number }).__browserPerfCollectMainHeap
    if (typeof collect !== 'function') throw new Error('Main process heap collection instrumentation is unavailable')
    const heap = collect()
    if (!Number.isFinite(heap) || heap <= 0) throw new Error('Main process heap collection returned an invalid measurement')
    return heap
  })
}

export async function readBrowserGuestFailures(app: ElectronApplication) {
  return app.evaluate(() => {
    const state = (globalThis as unknown as { __browserPerf?: { crashes: number; unresponsive: number; navigations: number } }).__browserPerf
    if (!state) throw new Error('Browser guest lifecycle observer was not attached')
    return { ...state }
  })
}

export function oneCoreProcessStats(stats: ProcessWindowStat | undefined, logicalCores: number) {
  return stats ? { ...stats, cpuOneCoreAvg: stats.cpuAvg * logicalCores, cpuOneCoreMax: stats.cpuMax * logicalCores } : null
}
