import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

const state = vi.hoisted(() => ({
  detail: vi.fn(), install: vi.fn(), blocked: false,
}))
vi.mock('../../../../src/main/http/routes/_shared', () => ({
  storeController: { getStoreAppDetail: state.detail, installStoreApp: state.install },
  MCP_COMMAND_BLOCKED: 'MCP_COMMAND_BLOCKED',
  rejectIfRemoteMcpForbiddenAsync: async (res: any) => {
    if (!state.blocked) return false
    res.status(403).json({ success: false, code: 'MCP_COMMAND_BLOCKED', error: 'Blocked' })
    return true
  },
  storeSlugIsMcp: vi.fn(), validateFilePath: vi.fn(),
}))
vi.mock('../../../../src/main/store', () => ({
  applyUpgrade: vi.fn(), previewUpgrade: vi.fn(), checkUpgradesNow: vi.fn(),
  publish: vi.fn(), getPublishPreview: vi.fn(), findAppByPublishSlug: vi.fn(),
}))
vi.mock('../../../../src/main/http/routes', async () => {
  const { registerStoreRoutes } = await import('../../../../src/main/http/routes/store.routes')
  return { registerApiRoutes: registerStoreRoutes }
})
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../../../src/main/http/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  generateAccessToken: () => 'fixture-only', getAccessToken: () => 'fixture-only',
  clearAccessToken: vi.fn(), restoreAccessToken: () => ({ ok: true }),
  handleLogin: vi.fn(), CredentialRestoreError: class extends Error {},
}))
vi.mock('../../../../src/main/http/websocket', () => ({
  initWebSocket: vi.fn(), shutdownWebSocket: vi.fn(), getClientCount: () => 0,
}))
vi.mock('../../../../src/main/http/invite-page', () => ({ getInvitePage: vi.fn() }))
vi.mock('../../../../src/main/http/renderer-assets', () => ({
  serveRendererAssets: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamStore: () => null }))
vi.mock('../../../../src/main/http/identity/index', () => ({ getLocalIdentity: () => ({ displayName: 'Fixture' }) }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ getMainWindow: () => null }))
vi.mock('fs', async importOriginal => ({
  ...await importOriginal<typeof import('fs')>(),
  readFileSync: () => '<!doctype html><html><head></head><body>Fixture shell</body></html>',
}))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

import { getExpressApp, startHttpServer, stopHttpServer } from '../../../../src/main/http/server'
import { storeApi } from '../../../../src/renderer/api/store.api'

let base: string
let proxy: Server
let origin: string
beforeAll(async () => {
  const info = await startHttpServer(0)
  const app = getExpressApp()!
  const wrapper = express()
  wrapper.use('/mounted', app)
  wrapper.use(app)
  proxy = await new Promise<Server>(resolve => {
    const started = wrapper.listen(0, '127.0.0.1', () => resolve(started))
  })
  origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  base = `${origin}/mounted/`
  expect(info.token).toBeTruthy()
})
afterAll(async () => {
  proxy.closeAllConnections()
  await new Promise<void>(resolve => proxy.close(() => resolve()))
  stopHttpServer()
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  state.blocked = false
  state.detail.mockImplementation(async (slug: string) => ({ success: true, data: { entry: { slug } } }))
  state.install.mockResolvedValue({ success: true, data: { appId: 'installed' } })
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', { baseURI: base })
  vi.stubGlobal('localStorage', { getItem: () => null })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const slugs = ['plain', 'owner/repo', 'example-author/a-long-hyphenated-listing-name', '@scope/name', 'author/中文 名称', 'owner/100%tool#part?x=1&y=2', 'owner/a%2Fb']
describe('store detail and installation over the actual HTTP stack', () => {
  it.each(slugs)('preserves the complete slug %s through renderer, transport and route', async slug => {
    expect(await storeApi.storeGetAppDetail(slug)).toEqual({ success: true, data: { entry: { slug } } })
    expect(state.detail).toHaveBeenCalledWith(slug)
    expect(await storeApi.storeInstall(slug, 'space-1', { option: 'value' })).toEqual({ success: true, data: { appId: 'installed' } })
    expect(state.install).toHaveBeenCalledWith(slug, 'space-1', { option: 'value' })
  })

  it.each(['', '?slug=', '?slug=a&slug=b'])('rejects invalid detail query %s as JSON', async query => {
    const response = await fetch(`${base}api/store/app-detail${query}`)
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect((await response.json()).success).toBe(false)
    expect(state.detail).not.toHaveBeenCalled()
  })

  it('also works without a reverse-proxy prefix', async () => {
    vi.stubGlobal('document', { baseURI: `${origin}/` })
    await storeApi.storeGetAppDetail('owner/repo')
    await storeApi.storeInstall('owner/repo', null)
    expect(state.detail).toHaveBeenCalledWith('owner/repo')
    expect(state.install).toHaveBeenCalledWith('owner/repo', null, undefined)
  })

  it('returns controller failures as JSON, not HTML', async () => {
    state.detail.mockRejectedValue(new Error('Registry unavailable'))
    expect(await storeApi.storeGetAppDetail('owner/repo')).toEqual({ success: false, error: 'Registry unavailable' })
    expect(console.error).toHaveBeenCalledWith('[HTTP] Store detail query failed:', 'Registry unavailable')
  })

  it('preserves not-found results instead of returning the SPA', async () => {
    state.detail.mockResolvedValue({ success: false, error: 'App not found: owner/missing' })
    expect(await storeApi.storeGetAppDetail('owner/missing')).toEqual({ success: false, error: 'App not found: owner/missing' })
  })

  it('keeps installation policy enforcement on the fixed endpoint', async () => {
    state.blocked = true
    expect(await storeApi.storeInstall('owner/mcp', null)).toEqual({ success: false, code: 'MCP_COMMAND_BLOCKED', error: 'Blocked' })
    expect(state.install).not.toHaveBeenCalled()
  })

  it('preserves the existing path endpoints for callers already using them', async () => {
    expect(await (await fetch(`${base}api/store/apps/owner/repo`)).json()).toEqual({ success: true, data: { entry: { slug: 'owner/repo' } } })
    const response = await fetch(`${base}api/store/apps/owner/repo/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spaceId: null }),
    })
    expect((await response.json()).success).toBe(true)
    expect(state.install).toHaveBeenCalledWith('owner/repo', null, undefined)
  })

  it('leaves desktop IPC requests unchanged', async () => {
    const detail = vi.fn().mockResolvedValue({ success: true })
    const install = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('window', { halo: { storeGetAppDetail: detail, storeInstall: install } })
    const slug = 'owner/name%#?'
    await storeApi.storeGetAppDetail(slug)
    await storeApi.storeInstall(slug, null)
    expect(detail).toHaveBeenCalledWith(slug)
    expect(install).toHaveBeenCalledWith({ slug, spaceId: null, userConfig: undefined }, undefined)
    expect(state.detail).not.toHaveBeenCalled()
    expect(state.install).not.toHaveBeenCalled()
  })
})
