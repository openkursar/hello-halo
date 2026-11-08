import { test as base, expect, chromium, type BrowserContext, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import electronPath from 'electron'
import express from 'express'
import { launchElectronApp } from './electron'
import { closeManagementApp, trackManagementApp, type OwnedManagementApp } from './acceptance-management-process'
import { waitForHomePage } from './helpers'
import { startAcceptanceModel, type AcceptanceModel } from './acceptance-model'
import type { SeededLegacySkill, LegacySkillRow } from './seed-legacy-skills-worker'
import type { RpcResponse } from '../../../src/shared/rpc/define'
import type { SkillDetail, SkillInventory, SkillRef } from '../../../src/shared/types/skills'
import type { RegistrySource } from '../../../src/shared/store/store-types'

const directory = dirname(fileURLToPath(import.meta.url))
const project = resolve(directory, '../../..')

export interface SkillServer {
  profile: string
  records: SeededLegacySkill[]
  app: ElectronApplication
  page: Page
  list(): Promise<SkillInventory>
  read(ref: SkillRef): Promise<SkillDetail>
  rows(): LegacySkillRow[]
  restart(afterClose?: () => void): Promise<Page>
  request<T>(path: string, body?: unknown): Promise<T>
  model?: AcceptanceModel
}

export function skillUpgradeAcceptance(caseId: string) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'app-e2e', mode: 'none', variant: {} }) } }
}

function isolatedEnvironment(profile: string): Record<string, string> {
  const environment = Object.fromEntries(Object.keys(process.env).filter(key => key !== 'ELECTRON_RUN_AS_NODE').map(key => [key, '']))
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) environment[key] = process.env[key]!
  }
  const systemPath = process.platform === 'win32'
    ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` : '/usr/bin:/bin:/usr/sbin:/sbin'
  for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') environment[key] = systemPath
  environment.PATH = systemPath
  return {
    ...environment, HOME: profile, USERPROFILE: profile, HALO_DATA_DIR: join(profile, '.halo'),
    XDG_CONFIG_HOME: join(profile, '.config'), XDG_CACHE_HOME: join(profile, '.cache'), XDG_DATA_HOME: join(profile, '.local/share'),
    APPDATA: join(profile, 'AppData/Roaming'), LOCALAPPDATA: join(profile, 'AppData/Local'),
    TMPDIR: join(profile, 'tmp'), TEMP: join(profile, 'tmp'), TMP: join(profile, 'tmp'),
    CLAUDE_CONFIG_DIR: join(profile, 'sdk-state'), NODE_ENV: 'production', LANG: 'en_US.UTF-8',
    HALO_ACCEPTANCE_MODE: 'deterministic',
  }
}

async function listen(server: Server | ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  return (server.address() as { port: number }).port
}

async function closeAssets(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
}

function networkEntry(entry: string, rendererPort: number, profile: string): string {
  const file = join(profile, 'server-entry.cjs')
  // Source builds proxy to 5173. Remap only that socket, never bind or contact the developer's server.
  writeFileSync(file, `const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const evidence = { listens: [], rendererConnections: 0, rendererPort: ${rendererPort} };
globalThis.acceptanceSkillNetwork = evidence;
globalThis.acceptanceSkillHome = require('node:os').homedir();
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  let requested;
  if (args[0] && typeof args[0] === 'object' && !args[0].path) {
    requested = args[0].host;
    args[0] = { ...args[0], host: requested === '::' ? '::1' : '127.0.0.1' };
  } else if (typeof args[0] === 'number') {
    requested = typeof args[1] === 'string' ? args[1] : undefined;
    if (typeof args[1] === 'string') args[1] = requested === '::' ? '::1' : '127.0.0.1';
    else args.splice(1, 0, '127.0.0.1');
  } else return originalListen.apply(this, args);
  const observation = { requestedHost: requested ?? 'unspecified', address: null };
  evidence.listens.push(observation);
  this.once('listening', () => { observation.address = this.address(); });
  return originalListen.apply(this, args);
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = normalized[0];
  if (options && typeof options === 'object' && Number(options.port) === 5173 && ['127.0.0.1', 'localhost', '::1'].includes(options.host || options.hostname)) {
    normalized[0] = { ...options, port: ${rendererPort}, host: '127.0.0.1', hostname: '127.0.0.1' };
    evidence.rendererConnections++;
  } else if (Number(normalized[0]) === 5173 && ['127.0.0.1', 'localhost', '::1'].includes(normalized[1])) {
    normalized[0] = ${rendererPort}; normalized[1] = '127.0.0.1'; evidence.rendererConnections++;
  }
  return originalConnect.apply(this, args);
};
syncBuiltinESMExports();
import(${JSON.stringify(pathToFileURL(entry).href)});
`)
  return file
}

export const test = base.extend<{ skillServer: SkillServer; useScriptedModel: boolean; skillRegistries: RegistrySource[] }>({
  useScriptedModel: [false, { option: true }],
  skillRegistries: [],
  skillServer: async ({ useScriptedModel, skillRegistries }, use, info) => {
    if (!process.env.HALO_ACCEPTANCE_MODE) throw new Error('Run this isolated fixture with HALO_ACCEPTANCE_MODE=deterministic so .env.local is never loaded')
    if (process.env.HALO_E2E_PACKAGED_APP) throw new Error('This source-build fixture does not claim packaged-app evidence')
    const bundled = chromium.executablePath()
    const installed = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const executablePath = existsSync(bundled) ? bundled : process.platform === 'darwin' && existsSync(installed) ? installed : undefined
    info.annotations.push({ type: 'acceptance-prerequisite', description: 'An already installed Playwright Chromium or macOS Google Chrome; no browser downloads' })
    base.skip(!executablePath, 'Headless browser prerequisite unavailable: install Chromium separately or supply the standard macOS Google Chrome installation; no app-e2e result was produced')
    const main = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).main as string
    const entry = resolve(project, main)
    if (!existsSync(entry) || !existsSync(join(project, 'out/renderer/index.html'))) throw new Error('A current controlled acceptance build is required')
    const profile = realpathSync(mkdtempSync(join(tmpdir(), 'halo-skill-upgrade-')))
    const haloDir = join(profile, '.halo')
    for (const path of [haloDir, join(profile, 'tmp'), join(profile, 'sdk-state')]) mkdirSync(path, { recursive: true })
    const environment = isolatedEnvironment(profile)
    const token = `Acceptance9-${randomBytes(24).toString('hex')}!`
    const applications: OwnedManagementApp[] = []
    const runtime: unknown[] = []
    const failures: unknown[] = []
    let assets: Server | undefined
    let context: BrowserContext | undefined
    let session: SkillServer | undefined
    let worker = ''
    let launchWithoutHandle = false
    let browserClosed = true
    let model: AcceptanceModel | undefined
    const redact = (text: string) => text.replaceAll(token, '[redacted temporary token]')
    try {
      if (useScriptedModel) model = await startAcceptanceModel()
      const now = new Date().toISOString()
      const source = model ? { id: 'acceptance-local', name: 'Local acceptance model', authType: 'api-key', provider: 'openai', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'gpt-4o', availableModels: [{ id: 'gpt-4o', name: 'gpt-4o' }], createdAt: now, updatedAt: now } : undefined
      writeFileSync(join(haloDir, 'config.json'), JSON.stringify({
        api: source ? { provider: source.provider, apiKey: source.apiKey, apiUrl: source.apiUrl, model: source.model } : { provider: 'openai', apiKey: '', apiUrl: 'http://127.0.0.1:9', model: 'not-configured' },
        aiSources: { version: 2, currentId: source?.id ?? null, sources: source ? [source] : [] }, modelConfigSkipped: true,
        agent: { sdkEngine: 'halo', configDirMode: 'custom', customConfigDir: join(profile, 'sdk-state') },
        appearance: { theme: 'dark', language: 'en' }, system: { autoLaunch: false },
        remoteAccess: { enabled: false, tunnelEnabled: false },
        onboarding: { completed: true }, isFirstLaunch: false, mcpServers: {},
        imChannels: { instances: [] }, notificationChannels: {},
        appStore: { registries: skillRegistries, autoCheckUpdates: false },
      }, null, 2))
      worker = join(profile, 'seed-legacy-skills.cjs')
      esbuild.buildSync({
        entryPoints: [join(directory, 'seed-legacy-skills-worker.ts')], outfile: worker,
        bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'],
        packages: 'external', logLevel: 'silent',
      })
      const runWorker = <T>(action: 'seed' | 'inspect', ids: string[] = []): T => {
        if (typeof electronPath !== 'string') throw new Error('The seed worker requires the Electron executable path, not an Electron main-process import')
        const output = execFileSync(electronPath, [worker, JSON.stringify({ profile, action, ids })], {
          env: { ...environment, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: join(project, 'node_modules') },
          encoding: 'utf8', timeout: 30000,
        })
        return JSON.parse(output.trim().split('\n').at(-1)!) as T
      }
      const records = runWorker<SeededLegacySkill[]>('seed')
      for (const record of records) expect(existsSync(record.destination), `Only the unrelated control may have files before launch: ${record.kind}`).toBe(record.kind === 'control')
      expect(existsSync(join(profile, '.claude/skills'))).toBe(false)
      expect(existsSync(join(haloDir, 'electron-user-data/claude-config/skills'))).toBe(false)
      await info.attach('legacy-database-precondition', { body: JSON.stringify({ records, rows: runWorker('inspect', records.map(record => record.id)) }, null, 2), contentType: 'application/json' })
      assets = createHttpServer(express().use(express.static(join(project, 'out/renderer'))))
      const rendererPort = await listen(assets)
      const wrappedEntry = networkEntry(entry, rendererPort, profile)
      const reservation = createServer()
      const port = await listen(reservation)
      await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()))
      const url = `http://127.0.0.1:${port}`
      const request = async <T>(path: string, body?: unknown): Promise<T> => {
        const response = await fetch(`${url}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) throw new Error(`Production HTTP ${path}: ${response.status}`)
        const result = await response.json() as RpcResponse<T>
        if (!result.success) throw new Error(`Production HTTP ${path}: ${result.error}`)
        return result.data!
      }
      const observe = async (app: ElectronApplication) => {
        const observed = await app.evaluate(({ app, BrowserWindow }) => ({
          pid: process.pid, home: process.env.HOME, userProfile: process.env.USERPROFILE, haloDir: process.env.HALO_DATA_DIR,
          osHome: (globalThis as unknown as { acceptanceSkillHome: string }).acceptanceSkillHome,
          appPath: app.getAppPath(), appData: app.getPath('appData'), userData: app.getPath('userData'),
          packaged: app.isPackaged, appVersion: app.getVersion(), electron: process.versions.electron, node: process.versions.node,
          serverMode: process.env.HALO_SERVER_MODE, windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible() })),
          network: (globalThis as unknown as { acceptanceSkillNetwork: { listens: Array<{ requestedHost: string; address: { address: string; port: number } | null }>; rendererConnections: number } }).acceptanceSkillNetwork,
        }))
        runtime.push(observed)
        expect(observed).toMatchObject({ home: profile, osHome: profile, userProfile: profile, haloDir, serverMode: '1' })
        expect(observed.userData.startsWith(`${profile}/`) || observed.userData.startsWith(`${profile}\\`)).toBe(true)
        expect(observed.appData.startsWith(`${profile}/`) || observed.appData.startsWith(`${profile}\\`)).toBe(true)
        expect(observed.windows.every(window => !window.visible), 'Production server mode must not display any Electron window').toBe(true)
        expect(observed.network.listens.some(item => item.requestedHost === '0.0.0.0' && item.address?.port === port)).toBe(true)
        expect(observed.network.listens.filter(item => item.address).every(item => ['127.0.0.1', '::1'].includes(item.address!.address))).toBe(true)
        return observed
      }
      const open = async () => {
        let app: ElectronApplication
        try {
          app = await launchElectronApp(wrappedEntry, profile, {
            bootstrapDirectory: project,
            env: { ...environment, HALO_SERVER_MODE: '1', HALO_SERVER_PORT: String(port), PORT: '', HALO_REMOTE_PASSWORD: token },
          })
        } catch (error) { launchWithoutHandle = true; throw error }
        applications.push(trackManagementApp(app, true))
        await expect.poll(async () => {
          try { return (await request<unknown[]>('/api/apps?type=skill')).length >= records.length - 2 }
          catch (error) { return error instanceof Error ? error.message : String(error) }
        }, { timeout: 45000, message: 'The production main process and authenticated app manager must become ready' }).toBe(true)
        expect((await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(5000) })).status).toBe(401)
        await observe(app)
        return app
      }
      const app = await open()
      context = await chromium.launchPersistentContext(join(profile, 'chrome-profile'), {
        executablePath, headless: true, env: environment, viewport: { width: 1280, height: 900 }, locale: 'en-US',
        args: ['--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync'],
      })
      browserClosed = false
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
      await context.addCookies([{ name: 'halo_authenticated', value: 'true', url }])
      await context.addInitScript(({ token, origin }) => {
        if (location.origin === origin) localStorage.setItem('halo_remote_token', token)
      }, { token, origin: url })
      const page = context.pages()[0] ?? await context.newPage()
      session = {
        profile, records, app, page, model, request,
        list: () => request<SkillInventory>('/api/skills/list', { spaceId: null, limit: 100 }),
        read: ref => request<SkillDetail>('/api/skills/read', ref),
        rows: () => runWorker<LegacySkillRow[]>('inspect', records.map(record => record.id)),
        async restart(afterClose) {
          await this.page.goto('about:blank')
          await closeManagementApp(applications.find(owned => owned.application === this.app)!, 15000, 'restart')
          afterClose?.()
          this.app = await open()
          await this.page.goto(url)
          await waitForHomePage(this.page)
          const observed = await observe(this.app)
          expect(observed.network.rendererConnections).toBeGreaterThan(0)
          return this.page
        },
      }
      await page.goto(url)
      await waitForHomePage(page)
      expect(await page.evaluate(() => 'halo' in window)).toBe(false)
      const observed = await observe(app)
      expect(observed.network.rendererConnections, 'The real HTTP server must proxy the built renderer, not a developer Vite process').toBeGreaterThan(0)
      await info.attach('skill-server-boundary', { body: JSON.stringify({
        main: entry, renderer: join(project, 'out/renderer'), browser: executablePath, headless: true,
        productionListenHost: '0.0.0.0', fixtureListenHost: '127.0.0.1', developerProxyPort: 5173, isolatedRendererPort: rendererPort,
        handlerReplacement: false, authReplacement: false, authPreseed: 'temporary Bearer token plus renderer cookie/localStorage',
        modelRequests: model ? 'scripted loopback endpoint; production engine and handlers unchanged' : 'none', trash: 'cancel only; later external removal is inside the disposable profile',
      }, null, 2), contentType: 'application/json' })
      await use(session)
      await observe(session.app)
      const config = await request<{ aiSources: { sources: unknown[] }; remoteAccess: { tunnelEnabled: boolean } }>('/api/config')
      expect(config.aiSources.sources).toHaveLength(model ? 1 : 0)
      expect(config.remoteAccess.tunnelEnabled).toBe(false)
      if (model) expect(model.errors).toEqual([])
    } catch (error) { failures.push(error) }
    finally {
      if (session && !session.page.isClosed()) {
        try { await session.page.screenshot({ path: info.outputPath('skill-upgrade-final.png') }) }
        catch (error) { failures.push(error) }
      }
      if (context) {
        try { await context.tracing.stop({ path: info.outputPath('skill-upgrade-trace.zip') }) }
        catch (error) { failures.push(error) }
        try { await context.close(); browserClosed = true }
        catch (error) { failures.push(error) }
      }
      for (const owned of applications) {
        try { await closeManagementApp(owned, 15000, 'teardown') }
        catch (error) { failures.push(error) }
      }
      if (assets) {
        try { await closeAssets(assets) }
        catch (error) { failures.push(error) }
      }
      if (model) {
        try {
          await info.attach('scripted-model-exchanges', { body: JSON.stringify({ exchanges: model.exchanges, errors: model.errors }), contentType: 'application/json' })
          await model.close()
        } catch (error) { failures.push(error) }
      }
      try {
        const log = join(haloDir, 'logs/main.log')
        if (existsSync(log)) await info.attach('skill-upgrade-main-log', { body: redact(readFileSync(log, 'utf8').slice(-1000000)), contentType: 'text/plain' })
        await info.attach('skill-server-lifecycle', { body: JSON.stringify({ runtime, shutdown: applications.map(owned => owned.diagnostics) }, null, 2), contentType: 'application/json' })
      } catch (error) { failures.push(error) }
      if (!launchWithoutHandle && browserClosed && applications.every(owned => owned.closed)) rmSync(profile, { recursive: true, force: true })
      else {
        console.error('[SkillUpgrade] Retained disposable profile because owned process exit was not established', { profile })
        failures.push(new Error(`Owned runtime cleanup incomplete; isolated profile retained at ${profile}`))
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Skill upgrade fixture failed; inspect lifecycle and main-log attachments')
  },
})

export { expect } from '@playwright/test'
