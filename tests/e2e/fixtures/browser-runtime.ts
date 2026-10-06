import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import { createServer } from 'node:net'
import { _electron as electron } from 'playwright'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './browser-site'
import { getAppEntryPath, createTestConfigDir, cleanupTestConfigDir } from './electron'
import type { AIBrowserLivePage } from '../../../src/shared/types/ai-browser'
import type { BrowserPolicy } from '../../../src/main/foundation/product-config'

const directory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(directory, '../../..')

export type ContextKind = 'main' | 'human' | 'automation'
export interface BrowserToolOutcome {
  result: { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }
  viewId: string | null
  pages: AIBrowserLivePage[]
}

export const test = base.extend<{ browserPolicy: BrowserPolicy | undefined; browserServerMode: boolean }>({
  browserPolicy: [undefined, { option: true }],
  browserServerMode: [false, { option: true }],
  electronApp: async ({ browserPolicy, browserServerMode }, use) => {
    const productionEntry = getAppEntryPath()
    const testConfigDir = createTestConfigDir(productionEntry)
    const identity = crypto.randomUUID()
    const outputRoot = path.join(projectRoot, 'out', `.e2e-browser-runtime-${identity}`)
    const mainDirectory = path.join(outputRoot, 'main')
    fs.mkdirSync(mainDirectory, { recursive: true })
    fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(mainDirectory, 'node_modules'), 'dir')
    fs.mkdirSync(path.join(outputRoot, 'preload'), { recursive: true })
    fs.symlinkSync(path.join(projectRoot, 'out/renderer'), path.join(outputRoot, 'renderer'), 'dir')
    fs.copyFileSync(path.join(projectRoot, 'out/preload/browser-host.cjs'), path.join(outputRoot, 'preload/browser-host.cjs'))
    const product = JSON.parse(fs.readFileSync(path.join(projectRoot, 'out/main/product.json'), 'utf8'))
    for (const provider of product.authProviders ?? []) if (provider.path) provider.path = path.resolve(projectRoot, 'out/main', provider.path)
    if (browserPolicy) product.browserPolicy = browserPolicy
    fs.writeFileSync(path.join(mainDirectory, 'product.json'), JSON.stringify(product))
    const main = path.join(mainDirectory, 'index.cjs')
    const preload = path.join(outputRoot, 'preload/index.cjs')
    const script = path.join(projectRoot, 'out/renderer', `.e2e-browser-runtime-${identity}.js`)
    const html = path.join(projectRoot, 'out/renderer', `.e2e-browser-runtime-${identity}.html`)
    const bundledPackages = new Set(['@xterm/headless', '@electron-toolkit/utils', 'uuid', 'open', 'proxy-agent'])
    await esbuild.build({
      entryPoints: [path.join(directory, browserServerMode ? 'browser-server-runtime-main.ts' : 'browser-runtime-main.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: main, logLevel: 'silent',
      plugins: [{
        name: 'runtime-package-boundary',
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, args => {
            if (args.path === 'electron' || args.path.startsWith('node:')) return { path: args.path, external: true }
            if (bundledPackages.has(args.path) || args.importer.includes('/node_modules/')) return
            return { path: args.path, external: true }
          })
          build.onLoad({ filter: /node_modules.*\.[cm]?js$/ }, args => {
            const contents = fs.readFileSync(args.path, 'utf8')
            if (!contents.includes('import.meta.url')) return
            return { contents: contents.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href)), loader: 'js', resolveDir: path.dirname(args.path) }
          })
        },
      }],
    })
    esbuild.buildSync({ entryPoints: [path.join(directory, 'browser-runtime-renderer.ts')], bundle: true, platform: 'browser', format: 'iife', outfile: script, logLevel: 'silent' })
    esbuild.buildSync({ entryPoints: [path.join(projectRoot, 'src/preload/index.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: preload, logLevel: 'silent', footer: { js: `const browserTestElectron = require('electron'); browserTestElectron.contextBridge.exposeInMainWorld('browserTest', { tool: (kind,name,args) => browserTestElectron.ipcRenderer.invoke('browser-test:tool',{kind,name,args}), release: kind => browserTestElectron.ipcRenderer.invoke('browser-test:release',kind), state: () => browserTestElectron.ipcRenderer.invoke('browser-test:state') });` } })
    fs.writeFileSync(html, `<!doctype html><html><body style="margin:0"><script src="${path.basename(script)}"></script></body></html>`)
    const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnvironment } = process.env
    const appData = path.join(testConfigDir, 'electron-data')
    fs.mkdirSync(appData, { recursive: true })
    const bootstrap = `${main}.bootstrap.cjs`
    fs.writeFileSync(bootstrap, `const { app } = require('electron'); app.setPath('userData',${JSON.stringify(appData)}); require(${JSON.stringify(main)});\n`)
    let instance: ElectronApplication | undefined
    try {
      let serverPort = ''
      if (browserServerMode) {
        const reservation = createServer()
        await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
        serverPort = String((reservation.address() as { port: number }).port)
        await new Promise<void>(resolve => reservation.close(() => resolve()))
      }
      instance = await electron.launch({ timeout: 30000, args: [...(process.env.HALO_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), bootstrap], env: { ...cleanEnvironment, ...(browserServerMode ? { HALO_SERVER_MODE: '1', HALO_SERVER_PORT: serverPort, PORT: serverPort, HALO_REMOTE_PASSWORD: 'CarrierServerFixture27' } : {}), HALO_DATA_DIR: path.join(testConfigDir, '.halo'), HALO_E2E_TEST: '1', HALO_BROWSER_TEST_PRELOAD: preload, HALO_BROWSER_TEST_HTML: html } })
      await use(instance)
    } finally {
      if (instance) await instance.close()
      cleanupTestConfigDir(testConfigDir)
      for (const file of [main, preload, script, html, bootstrap]) fs.rmSync(file, { force: true })
      fs.rmSync(outputRoot, { recursive: true, force: true })
    }
  },
})

export { expect }

export async function callBrowserTool(window: Page, kind: ContextKind, name: string, args: Record<string, unknown> = {}): Promise<BrowserToolOutcome> {
  const outcome = await window.evaluate(async ({ kind, name, args }) =>
    (window as unknown as { browserTest: { tool: (kind: string, name: string, args: Record<string, unknown>) => Promise<BrowserToolOutcome> } }).browserTest.tool(kind, name, args), { kind, name, args })
  expect(outcome.result, `${kind} ${name} must execute its production tool handler`).not.toMatchObject({ isError: true })
  return outcome
}

export function toolText(outcome: BrowserToolOutcome): string {
  return outcome.result.content.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n')
}
