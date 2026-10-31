import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { BrowserContext, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { test as base, expect } from './acceptance-management'

interface BindingAttempt {
  requestedHost: string | null
  requestedPort: number
  actual: { address: string; family: string; port: number } | null
  failed: boolean
  listening: boolean
}
interface BindingSnapshot { installed: boolean; attempts: BindingAttempt[]; violations: string[] }
interface BindingGuard { snapshot(): BindingSnapshot; restore(): { restored: boolean; violations: string[] } }
interface BindingGlobal { acceptanceRemoteBinding?: BindingGuard }

// Serialized into the owned Electron process; it must not capture this fixture's imports.
export function installRemoteLoopbackGuard(): BindingSnapshot {
  const state = globalThis as unknown as BindingGlobal
  if (state.acceptanceRemoteBinding) throw new Error('The owned process already has a remote binding guard')
  const network = process.getBuiltinModule('node:net') as typeof import('node:net')
  const original = network.Server.prototype.listen
  const violations: string[] = []
  const records: Array<{ server: import('node:net').Server; attempt: Omit<BindingAttempt, 'listening'>; observed: () => void }> = []
  const reject = (reason: string): never => {
    violations.push(reason)
    throw new Error(`Remote loopback fixture rejected ${reason}`)
  }
  const portValue = (port: unknown): number => {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) return reject('unrecognized-listen-port')
    return port
  }
  const pinnedHost = (host: unknown): string => {
    if (host === undefined || host === '0.0.0.0' || host === '::' || host === 'localhost') return '127.0.0.1'
    if (host === '127.0.0.1' || host === '::1') return host
    return reject('non-loopback-listen-host')
  }
  const guarded = function (this: import('node:net').Server, ...input: unknown[]) {
    const args = [...input]
    let port: number
    let host: unknown
    if (typeof args[0] === 'number') {
      port = portValue(args[0])
      if (typeof args[1] === 'string' || args[1] === undefined) {
        host = args[1]
        args[1] = pinnedHost(host)
      } else if (typeof args[1] === 'function' || typeof args[1] === 'number') args.splice(1, 0, '127.0.0.1')
      else return reject('unrecognized-listen-signature')
      let backlog = false
      let callback = false
      for (const item of args.slice(2)) {
        if (item === undefined) continue
        if (typeof item === 'number' && Number.isInteger(item) && item >= 0 && !backlog && !callback) backlog = true
        else if (typeof item === 'function' && !callback) callback = true
        else return reject('unrecognized-listen-signature')
      }
    } else if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      const options = args[0] as Record<string, unknown>
      if ('path' in options || 'fd' in options || args.length > 2 || args[1] !== undefined && typeof args[1] !== 'function') return reject('unrecognized-listen-signature')
      port = portValue(options.port)
      host = options.host
      args[0] = { ...options, host: pinnedHost(host) }
    } else return reject('unrecognized-listen-signature')
    const attempt: Omit<BindingAttempt, 'listening'> = { requestedHost: typeof host === 'string' ? host : null, requestedPort: port, actual: null, failed: false }
    const observed = () => {
      const address = this.address()
      if (!address || typeof address === 'string' || !['127.0.0.1', '::1'].includes(address.address)) {
        violations.push('non-loopback-bound-address')
        attempt.failed = true
        this.close()
        console.error('[AcceptanceRemote] Closed an owned listener whose loopback address could not be confirmed')
        return
      }
      attempt.actual = { address: address.address, family: address.family, port: address.port }
    }
    records.push({ server: this, attempt, observed })
    this.prependOnceListener('listening', observed)
    try { return Reflect.apply(original, this, args) }
    catch (error) { attempt.failed = true; this.removeListener('listening', observed); throw error }
  }
  network.Server.prototype.listen = guarded as typeof original
  state.acceptanceRemoteBinding = {
    snapshot: () => ({ installed: network.Server.prototype.listen === guarded, attempts: records.map(({ server, attempt }) => ({ ...attempt, listening: server.listening })), violations: [...violations] }),
    restore() {
      if (records.some(record => record.server.listening)) throw new Error('Refusing to remove the remote binding guard while an owned listener is active')
      if (network.Server.prototype.listen !== guarded) throw new Error('The owned listener implementation changed while the remote binding guard was installed')
      for (const record of records) record.server.removeListener('listening', record.observed)
      network.Server.prototype.listen = original
      delete state.acceptanceRemoteBinding
      return { restored: network.Server.prototype.listen === original, violations: [...violations] }
    },
  }
  return state.acceptanceRemoteBinding.snapshot()
}

export function readRemoteLoopbackGuard(): BindingSnapshot {
  const guard = (globalThis as unknown as BindingGlobal).acceptanceRemoteBinding
  if (!guard) throw new Error('The owned process has no remote binding guard')
  return guard.snapshot()
}

export function restoreRemoteLoopbackGuard() {
  const guard = (globalThis as unknown as BindingGlobal).acceptanceRemoteBinding
  if (!guard) throw new Error('The owned process has no remote binding guard to restore')
  return guard.restore()
}

interface RemoteStatus { enabled: boolean; server: { port: number; token: string | null; running: boolean } }
interface RemoteDesktop {
  page: Page
  url: string
  requests: Array<{ method: string; path: string }>
  login(): Promise<void>
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

export const test = base.extend<{ remoteDesktop: RemoteDesktop }>({
  remoteDesktop: async ({ managementApp, browser }, use, info) => {
    const failures: unknown[] = []
    const bindings: Array<{ phase: string; state: unknown }> = []
    const requests: RemoteDesktop['requests'] = []
    let context: BrowserContext | undefined
    let remotePage: Page | undefined
    let guardInstalled = false
    let assets: ReturnType<typeof createHttpServer> | undefined
    try {
      const before = await managementApp.window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getRemoteStatus())
      expect(before).toMatchObject({ success: true, data: { enabled: false, server: { running: false } } })
      bindings.push({ phase: 'guard-installed', state: await managementApp.app.evaluate(installRemoteLoopbackGuard) })
      guardInstalled = true
      const packaged = await managementApp.app.evaluate(({ app }) => app.isPackaged)
      if (!packaged) {
        const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
        assets = createHttpServer(express().use(express.static(resolve(project, 'out/renderer'))))
        await new Promise<void>((resolve, reject) => { assets!.once('error', reject); assets!.listen(5173, '127.0.0.1', resolve) })
      }
      const enabled = await managementApp.window.evaluate(async port => (globalThis as unknown as { halo: HaloAPI }).halo.enableRemoteAccess(port), await freePort())
      expect(enabled.success).toBe(true)
      const status = enabled.data as RemoteStatus
      expect(status.server.running).toBe(true)
      expect(status.server.token).toBeTruthy()
      const bound = await managementApp.app.evaluate(readRemoteLoopbackGuard)
      bindings.push({ phase: 'server-enabled', state: bound })
      expect(bound.installed).toBe(true)
      expect(bound.violations).toEqual([])
      expect(bound.attempts.filter(attempt => attempt.listening)).toEqual([expect.objectContaining({ requestedPort: status.server.port, actual: { address: '127.0.0.1', family: 'IPv4', port: status.server.port }, failed: false })])
      context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
      const page = await context.newPage()
      remotePage = page
      const url = `http://127.0.0.1:${status.server.port}`
      page.on('request', request => {
        const target = new URL(request.url())
        if (target.origin === url && target.pathname.startsWith('/api/spaces')) requests.push({ method: request.method(), path: target.pathname })
      })
      await page.goto(url)
      await expect(page.getByPlaceholder('Access Code', { exact: true })).toBeVisible()
      await use({
        page, url, requests,
        async login() {
          await page.getByPlaceholder('Access Code', { exact: true }).fill(status.server.token!)
          await page.getByRole('button', { name: 'Connect', exact: true }).click()
          await expect(page.getByRole('button', { name: 'Conversation', exact: true })).toBeVisible({ timeout: 30000 })
          expect(await page.evaluate(() => 'halo' in globalThis)).toBe(false)
        },
      })
    } catch (error) { failures.push(error) }
    finally {
      try {
        if (remotePage && !remotePage.isClosed()) await info.attach('remote-final-window', {
          body: await remotePage.screenshot({ mask: [remotePage.getByPlaceholder('Access Code', { exact: true })] }),
          contentType: 'image/png',
        })
      } catch (error) { failures.push(error) }
      try { await context?.close() } catch (error) { failures.push(error) }
      if (guardInstalled) {
        try {
          const stopped = await managementApp.window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.disableRemoteAccess())
          expect(stopped.success).toBe(true)
          const status = await managementApp.window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getRemoteStatus())
          expect(status).toMatchObject({ success: true, data: { enabled: false, server: { running: false } } })
        } catch (error) { failures.push(error) }
        try {
          const stopped = await managementApp.app.evaluate(readRemoteLoopbackGuard)
          bindings.push({ phase: 'server-stopped', state: stopped })
          expect(stopped.violations).toEqual([])
          expect(stopped.attempts.filter(attempt => attempt.listening)).toEqual([])
        } catch (error) { failures.push(error) }
        try { bindings.push({ phase: 'guard-restored', state: await managementApp.app.evaluate(restoreRemoteLoopbackGuard) }) }
        catch (error) { failures.push(error) }
      }
      if (assets) {
        assets.closeAllConnections()
        try { await new Promise<void>((resolve, reject) => assets!.close(error => error ? reject(error) : resolve())) } catch (error) { failures.push(error) }
      }
      try { await info.attach('remote-loopback-boundary', { body: JSON.stringify({ bindings, requests, scope: 'Real remote UI and application handlers with a test-only loopback listener constraint; no LAN claim.' }, null, 2), contentType: 'application/json' }) }
      catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, `Remote desktop-only fixture lifecycle failed: ${failures.map(error => error instanceof Error ? error.message : String(error)).join('; ')}`)
  },
})

export { expect } from '@playwright/test'
