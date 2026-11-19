/**
 * Store listings can carry scoped slugs ("owner/repo"). The detail and
 * path-style install routes must hand the whole slug to the controller rather
 * than 404 on the extra segment. Driven over HTTP because only Express itself
 * decides how a wildcard segment is matched and split.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

const { getStoreAppDetail, installStoreApp } = vi.hoisted(() => ({
  getStoreAppDetail: vi.fn(async (slug: string) => ({ success: true, data: { slug } })),
  installStoreApp: vi.fn(async (slug: string) => ({ success: true, data: { appId: `id:${slug}` } })),
}))

vi.mock('../../../src/main/http/routes/_shared', () => ({
  MCP_COMMAND_BLOCKED: 'MCP_COMMAND_BLOCKED',
  rejectIfRemoteMcpForbiddenAsync: vi.fn(async () => false),
  storeController: { getStoreAppDetail, installStoreApp },
  storeSlugIsMcp: vi.fn(async () => false),
  validateFilePath: vi.fn(() => true),
}))
vi.mock('../../../src/main/store', () => ({
  applyUpgrade: vi.fn(),
  previewUpgrade: vi.fn(),
  checkUpgradesNow: vi.fn(),
  publish: vi.fn(),
  getPublishPreview: vi.fn(),
  findAppByPublishSlug: vi.fn(),
}))
vi.mock('../../../src/main/apps/manager', () => ({ getAppManager: vi.fn() }))
vi.mock('../../../src/main/apps/runtime', () => ({ getAppRuntime: vi.fn() }))

import { registerStoreRoutes, slugFromPath } from '../../../src/main/http/routes/store.routes'

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  registerStoreRoutes(app)
  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

beforeEach(() => {
  getStoreAppDetail.mockClear()
  installStoreApp.mockClear()
})

describe('slugFromPath', () => {
  it('joins split segments and passes plain strings through', () => {
    expect(slugFromPath(['owner', 'repo'])).toBe('owner/repo')
    expect(slugFromPath('plain')).toBe('plain')
    expect(slugFromPath(undefined)).toBe('')
  })
})

describe('store routes with scoped slugs', () => {
  it('GET detail accepts a plain slug', async () => {
    const res = await fetch(`${base}/api/store/apps/plain-app`)
    expect(res.status).toBe(200)
    expect(getStoreAppDetail).toHaveBeenCalledWith('plain-app')
  })

  it('GET detail accepts a scoped slug', async () => {
    const res = await fetch(`${base}/api/store/apps/owner/repo`)
    expect(res.status).toBe(200)
    expect(getStoreAppDetail).toHaveBeenCalledWith('owner/repo')
  })

  it('POST install accepts a scoped slug in the path', async () => {
    const res = await fetch(`${base}/api/store/apps/owner/repo/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spaceId: 'space-1' }),
    })
    expect(res.status).toBe(200)
    expect(installStoreApp).toHaveBeenCalledWith('owner/repo', 'space-1', undefined)
    expect(getStoreAppDetail).not.toHaveBeenCalled()
  })
})
