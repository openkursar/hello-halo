import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { runInNewContext } from 'vm'
import { renderCredentialPreload } from '../../../src/main/services/cli-tools/credentials'
import type { EnterpriseToolBindingConfig } from '../../../src/main/services/enterprise-identity/service'
import { contextBridge, ipcRenderer } from 'electron'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Express, Request, Response } from 'express'

const mocks = vi.hoisted(() => ({
  resume: vi.fn(), removeListener: vi.fn(), openWindow: vi.fn(),
  cleanup: vi.fn<Parameters<typeof import('fs').promises.rm>, Promise<void>>(),
  retire: vi.fn<Parameters<typeof import('fs').promises.rename>, Promise<void>>(),
  config: vi.fn<[], { provider: string; name?: string; toolCredentials?: EnterpriseToolBindingConfig[] } | undefined>(),
  productPath: vi.fn(() => join(tmpdir(), 'product.json')),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'en' },
  powerMonitor: { on: mocks.resume, removeListener: mocks.removeListener },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}))
vi.mock('fs', async importOriginal => {
  const fs = await importOriginal<typeof import('fs')>()
  return { ...fs, promises: { ...fs.promises, rm: mocks.cleanup, rename: mocks.retire } }
})
vi.mock('../../../src/main/foundation/product-config', () => ({
  getEnterpriseIdentityConfig: mocks.config,
  getProductConfigPath: mocks.productPath,
}))
vi.mock('../../../src/main/services/login-window', () => ({ openLoginWindow: mocks.openWindow }))

import {
  getEnterpriseIdentityState, getToolCredentialBindings, initEnterpriseIdentity, peekEnterpriseIdentityState,
  retryEnterpriseIdentity, shutdownEnterpriseIdentity, signInEnterpriseIdentity, signOutEnterpriseIdentity,
} from '../../../src/main/services/enterprise-identity'
import { registerEnterpriseIdentityRoutes } from '../../../src/main/http/routes/enterprise-identity.routes'

const require = createRequire(import.meta.url)
const bindings = [{ toolId: 'npm.example', capability: 'code', audience: 'code-host', env: 'ORG_TOKEN' }]
function launcherToken(credentialDir: string): string | undefined {
  const file = join(credentialDir, 'code-host.json')
  const env: Record<string, string> = { ORG_TOKEN: 'inherited' }
  runInNewContext(renderCredentialPreload({ ...bindings[0], file }), { process: { env }, require, Date })
  return env.ORG_TOKEN
}

function configureProvider(dir: string, credentialDir: string, onDidChange = vi.fn()) {
  writeFileSync(join(dir, 'provider.mjs'), `export function getTestProvider() {
    return {
      contractVersion: 2,
      capabilityCatalog: () => [{ id: 'code', label: 'Code' }],
      snapshot: () => ({ phase: 'settled', subject: 'account', capabilities: { code: { status: 'ready' } } }),
      onDidChange: () => ({ dispose() {} }),
      issueCredential: async () => ({ token: 'new-token', expiresAt: Date.now() + 60000 }),
      signOut: async () => { throw new Error('unexpected sign-out') },
    }
  }`)
  mocks.config.mockReturnValue({ provider: 'provider.mjs', name: 'Organization', toolCredentials: bindings })
  mocks.productPath.mockReturnValue(join(dir, 'product.json'))
  initEnterpriseIdentity({ credentialDir, onDidChange })
}

beforeEach(async () => {
  const { promises } = await vi.importActual<typeof import('fs')>('fs')
  mocks.cleanup.mockReset().mockImplementation(promises.rm)
  mocks.retire.mockReset().mockImplementation(promises.rename)
  mocks.productPath.mockReset().mockReturnValue(join(tmpdir(), 'product.json'))
})

afterEach(() => {
  shutdownEnterpriseIdentity()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  mocks.config.mockReset()
})

describe('organization sign-in host', () => {
  it('does no provider, credential, timer or listener work when unconfigured', async () => {
    vi.useFakeTimers()
    const onDidChange = vi.fn()
    initEnterpriseIdentity({ credentialDir: '/unused', onDidChange })
    expect(peekEnterpriseIdentityState().status).toBe('unconfigured')
    expect(getEnterpriseIdentityState().status).toBe('unconfigured')
    expect(getToolCredentialBindings()).toEqual([])
    expect(await signInEnterpriseIdentity()).toBe('failed')
    expect((await signOutEnterpriseIdentity('session')).status).toBe('unconfigured')
    expect(mocks.cleanup).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(mocks.openWindow).not.toHaveBeenCalled()
    expect(onDidChange).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('exposes the desktop preload flag without IPC only when configured (%s)', async configured => {
    const originalArgv = process.argv
    const originalGetSystemVersion = process.getSystemVersion
    try {
      vi.resetModules()
      process.argv = ['electron', ...(configured ? ['--halo-org-sign-in=1'] : [])]
      process.getSystemVersion = () => '15.1'
      await import('../../../src/preload')
      const flagCalls = vi.mocked(contextBridge.exposeInMainWorld).mock.calls.filter(([key]) => key === 'haloOrgSignIn')
      expect(flagCalls).toEqual(configured ? [['haloOrgSignIn', true]] : [])
      expect(ipcRenderer.invoke).not.toHaveBeenCalled()
      expect(vi.mocked(ipcRenderer.on).mock.calls.map(([channel]) => channel)).not.toContain('enterprise-identity:changed')
    } finally {
      process.argv = originalArgv
      if (originalGetSystemVersion) process.getSystemVersion = originalGetSystemVersion
      else Reflect.deleteProperty(process, 'getSystemVersion')
    }
  })

  it('subscribes to resume only on demand and detaches on shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-org-host-'))
    const credentialDir = join(dir, 'credentials')
    try {
      mocks.config.mockReturnValue({ provider: 'missing-test-provider.js', name: 'Organization' })
      const changed = vi.fn()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      initEnterpriseIdentity({ credentialDir, onDidChange: changed })
      expect(peekEnterpriseIdentityState().status).toBe('loading')
      expect(mocks.resume).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
      expect(getEnterpriseIdentityState()).toMatchObject({ status: 'loading', name: 'Organization' })
      expect(mocks.resume.mock.calls).toEqual([['resume', expect.any(Function)]])
      await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ status: 'unavailable' })))
      const listener = mocks.resume.mock.calls[0][1]
      shutdownEnterpriseIdentity()
      expect(mocks.removeListener.mock.calls).toEqual([['resume', listener]])
      expect(existsSync(credentialDir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detaches startup leftovers when directory removal fails, before loading the provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-org-host-'))
    const credentialDir = join(dir, 'credentials')
    try {
      mkdirSync(credentialDir)
      writeFileSync(join(credentialDir, 'code-host.json'), JSON.stringify({ token: 'leftover', expiresAt: Date.now() + 60_000 }))
      expect(launcherToken(credentialDir)).toBe('leftover')
      mocks.cleanup.mockRejectedValueOnce(new Error('remove failed'))
      configureProvider(dir, credentialDir)
      await vi.waitFor(() => expect(launcherToken(credentialDir)).toBeUndefined())
      expect(mocks.retire).toHaveBeenCalledWith(credentialDir, expect.stringContaining('.retired'))
      expect(mocks.productPath).not.toHaveBeenCalled()
      expect(peekEnterpriseIdentityState().status).toBe('loading')
    } finally {
      shutdownEnterpriseIdentity()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('blocks issuance when startup leftovers cannot be detached and retries cleanup on demand', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-org-host-'))
    const credentialDir = join(dir, 'credentials')
    try {
      mkdirSync(credentialDir)
      writeFileSync(join(credentialDir, 'code-host.json'), JSON.stringify({ token: 'leftover', expiresAt: Date.now() + 60_000 }))
      mocks.cleanup.mockRejectedValueOnce(new Error('remove failed'))
      mocks.retire.mockRejectedValueOnce(new Error('rename failed'))
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      configureProvider(dir, credentialDir)
      getEnterpriseIdentityState()
      await vi.waitFor(() => expect(peekEnterpriseIdentityState()).toMatchObject({ status: 'active', withdrawalPending: true }))
      expect(peekEnterpriseIdentityState().boundTools).toEqual([{ toolId: 'npm.example', capability: 'code', access: 'maybe-still-valid' }])
      expect(peekEnterpriseIdentityState().credentialFailed).toBeUndefined()
      expect(launcherToken(credentialDir)).toBe('leftover')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not detach credentials'))
      await retryEnterpriseIdentity()
      await vi.waitFor(() => expect(launcherToken(credentialDir)).toBe('new-token'))
      expect(peekEnterpriseIdentityState().withdrawalPending).toBeUndefined()
    } finally {
      shutdownEnterpriseIdentity()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows remote state but rejects sign-in and both sign-out scopes without changing desktop credentials', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const routes = new Map<string, (req: Request, res: Response) => unknown>()
    registerEnterpriseIdentityRoutes({ post: routes.set.bind(routes) } as unknown as Express)
    const request = async (path: string, input?: unknown) => {
      const response = { status: vi.fn().mockReturnThis(), json: vi.fn() }
      const route = routes.get(`/api/enterprise-identity/${path}`)
      expect(route).toBeDefined()
      await route!({ body: input } as Request, response as unknown as Response)
      return response
    }
    const dir = mkdtempSync(join(tmpdir(), 'halo-org-host-'))
    const credentialDir = join(dir, 'credentials')
    try {
      configureProvider(dir, credentialDir)
      for (const response of [await request('sign-in'), await request('retry'), await request('sign-out', { scope: 'session' }), await request('sign-out', { scope: 'device' })]) {
        expect(response.status).toHaveBeenCalledWith(403)
        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'DESKTOP_ONLY' }))
      }
      expect(mocks.resume).not.toHaveBeenCalled()
      expect(mocks.productPath).not.toHaveBeenCalled()
      expect((await request('state')).json).toHaveBeenCalledWith({
        success: true, data: expect.objectContaining({ status: 'loading' }),
      })
      await vi.waitFor(() => expect(launcherToken(credentialDir)).toBe('new-token'))
      expect((await request('sign-out', { scope: 'session' })).status).toHaveBeenCalledWith(403)
      expect((await request('sign-out', { scope: 'device' })).status).toHaveBeenCalledWith(403)
      expect(launcherToken(credentialDir)).toBe('new-token')
      expect(peekEnterpriseIdentityState().status).toBe('active')
      expect(mocks.openWindow).not.toHaveBeenCalled()
      expect(routes.size).toBe(4)
    } finally {
      shutdownEnterpriseIdentity()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
