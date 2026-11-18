import { once } from 'node:events'
import { createServer } from 'node:net'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { test as base, expect, attachProbe } from './acceptance-app'
import { createTestConfigDir, getAppEntryPath, launchElectronApp, cleanupTestConfigDir } from './electron'
import { startAcceptanceModel, type AcceptanceModel } from './acceptance-model'
import { installRemoteLoopbackGuard, readRemoteLoopbackGuard } from './acceptance-remote-lifecycle'

export interface OfficeNode {
  window: Page
  profile: string
  url: string
  api<T = any>(method: string, path: string, body?: unknown): Promise<T>
}

async function freeOfficePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

export async function connectOfficeNode(window: Page, profile: string): Promise<OfficeNode> {
  const enabled = await window.evaluate(port => (globalThis as unknown as { halo: HaloAPI }).halo.enableRemoteAccess(port), await freeOfficePort())
  expect(enabled.success, enabled.error).toBe(true)
  const status = enabled.data as { server: { running: boolean; port: number; token: string } }
  expect(status.server.running).toBe(true)
  expect(status.server.token).toBeTruthy()
  const url = `http://127.0.0.1:${status.server.port}`
  return { window, profile, url, async api(method, path, body) {
    const response = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${status.server.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json() as { success: boolean; error?: string; data: any }
    expect(response.ok, `${method} ${path}: ${result.error ?? response.status}`).toBe(true)
    expect(result.success, `${method} ${path}: ${result.error}`).toBe(true)
    return result.data
  } }
}

async function closeOfficeApplication(app: ElectronApplication) {
  const child = app.process()
  const exited = () => child.exitCode !== null || child.signalCode !== null
  if (exited()) return
  const exit = once(child, 'exit')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([Promise.all([app.close(), exit]), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Owned office application did not exit within 15 seconds')), 15000) })])
  } finally {
    clearTimeout(timer)
    if (!exited()) {
      child.kill('SIGKILL')
      let killTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([exit, new Promise<never>((_resolve, reject) => { killTimer = setTimeout(() => reject(new Error('Owned office application exit remained unconfirmed after SIGKILL')), 5000) })])
      } finally { clearTimeout(killTimer) }
    }
  }
}

export function officeWorkspaceDirectories(profile: string): string[] {
  const root = join(profile, '.halo', 'team-work')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const directory = join(root, entry.name)
    return [entry.name, ...readdirSync(directory, { withFileTypes: true }).filter(child => child.isDirectory()).map(child => `${entry.name}/${child.name}`)]
  }).sort()
}

export const test = base.extend<{ officeNodes: { authority: OfficeNode; owner: OfficeNode; observer: OfficeNode; ownerModel: AcceptanceModel } }>({
  officeNodes: async ({ acceptanceApp }, use, info) => {
    expect(process.env.HALO_E2E_HIDDEN_WINDOWS, 'Three-node acceptance must use the existing hidden bootstrap').toBe('1')
    const ownerModel = await startAcceptanceModel()
    const entry = getAppEntryPath()
    const owned: Array<{ profile: string; app?: ElectronApplication }> = []
    const failures: unknown[] = []
    const guarded: Array<{ app: ElectronApplication; window: Page; profile: string; label: string }> = []
    const guard = async (app: ElectronApplication, window: Page, profile: string, label: string) => {
      expect(await app.evaluate(installRemoteLoopbackGuard)).toMatchObject({ installed: true, violations: [] })
      guarded.push({ app, window, profile, label })
    }
    const open = async () => {
      const profile = createTestConfigDir(entry, [], { sdkEngine: 'halo' })
      const record: { profile: string; app?: ElectronApplication } = { profile }
      owned.push(record)
      const file = join(profile, '.halo', 'config.json')
      const config = JSON.parse(readFileSync(file, 'utf8'))
      const timestamp = new Date().toISOString()
      const source = { id: 'office-private-source', name: 'Office private model', provider: 'openai', authType: 'api-key', apiKey: 'office-private-credential-canary', apiUrl: ownerModel.url, apiType: 'chat_completions', model: 'o3', availableModels: [{ id: 'o3', name: 'o3' }], createdAt: timestamp, updatedAt: timestamp }
      config.api = { provider: source.provider, apiKey: source.apiKey, apiUrl: source.apiUrl, model: source.model }
      config.aiSources = { version: 2, currentId: source.id, sources: [source] }
      config.agent = { ...config.agent, sdkEngine: 'halo', configDirMode: 'custom', customConfigDir: join(profile, 'sdk-state'), maxTurns: 16 }
      config.imChannels = { instances: [] }
      config.notificationChannels = {}
      writeFileSync(file, JSON.stringify(config))
      record.app = await launchElectronApp(entry, profile)
      const window = await record.app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await attachProbe(window)
      await expect.poll(async () => (await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.appGetOverview())).success, { timeout: 30000 }).toBe(true)
      const availability = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
      expect(availability).toMatchObject({ success: true, data: { activeEngine: 'halo', degradedFrom: null } })
      await guard(record.app, window, profile, `joiner-${owned.length}`)
      return connectOfficeNode(window, profile)
    }
    try {
      await guard(acceptanceApp.app, acceptanceApp.window, acceptanceApp.profile, 'authority')
      const authority = await connectOfficeNode(acceptanceApp.window, acceptanceApp.profile)
      const owner = await open()
      const observer = await open()
      await use({ authority, owner, observer, ownerModel })
    } catch (error) { failures.push(error) }
    finally {
      for (const node of guarded) {
        try {
          const binding = await node.app.evaluate(readRemoteLoopbackGuard)
          await info.attach(`office-${node.label}-loopback`, { body: JSON.stringify(binding), contentType: 'application/json' })
          expect(binding.violations).toEqual([])
          expect(binding.attempts.some(attempt => attempt.listening && attempt.actual?.address === '127.0.0.1')).toBe(true)
          const disabled = await node.window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.disableRemoteAccess())
          expect(disabled.success, disabled.error).toBe(true)
          expect(await node.app.evaluate(() => {
            const guard = (globalThis as unknown as { acceptanceRemoteBinding: { restore(): unknown } }).acceptanceRemoteBinding
            return guard.restore()
          })).toMatchObject({ restored: true, violations: [] })
        } catch (error) { failures.push(error) }
      }
      for (const record of owned.reverse()) {
        const log = join(record.profile, '.halo', 'logs', 'main.log')
        try {
          if (existsSync(log)) await info.attach(`office-${owned.indexOf(record)}-main-log`, { body: readFileSync(log).subarray(-1000000), contentType: 'text/plain' })
        } catch (error) { failures.push(error) }
        if (!record.app) {
          failures.push(new Error(`Retained isolated office profile after launch without a process handle: ${record.profile}`))
          continue
        }
        if (record.app) {
          const child = record.app.process()
          try { await closeOfficeApplication(record.app) } catch (error) { failures.push(error) }
          if (child.exitCode === null && child.signalCode === null) {
            failures.push(new Error('Retained an office profile because process exit was not established'))
            continue
          }
        }
        try { cleanupTestConfigDir(record.profile) } catch (error) { failures.push(error) }
      }
      try { await info.attach('office-owner-model-exchanges', { body: JSON.stringify({ exchanges: ownerModel.exchanges, errors: ownerModel.errors }), contentType: 'application/json' }) } catch (error) { failures.push(error) }
      await ownerModel.close()
    }
    if (failures.length) throw new AggregateError(failures, 'Owned office acceptance lifecycle failed')
  },
})
