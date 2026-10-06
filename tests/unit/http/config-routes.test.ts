/**
 * A settings save over HTTP carries the stamp of the settings it was built on
 * as `?snapshotEpoch=`, so a remote client gets the same protection as the
 * desktop app after a failed read of the config file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { setConfig } = vi.hoisted(() => ({
  setConfig: vi.fn((_updates: unknown, _snapshotEpoch?: number) => ({ success: true })),
}))
vi.mock('../../../src/main/http/routes/_shared', () => ({
  configController: { setConfig },
  configTouchesMcp: () => false,
  getAISourceManager: vi.fn(),
  getPublicSecurityPolicy: vi.fn(),
  rejectIfRemoteMcpForbidden: () => false,
  rejectIfRemoteBrowserAllowlistForbidden: () => false,
}))

import { registerConfigRoutes } from '../../../src/main/http/routes/config.routes'

async function postConfig(query: Record<string, unknown>) {
  const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
  const app = Object.fromEntries(['get', 'post'].map(verb => [verb, (url: string, handler: never) => routes.set(`${verb} ${url}`, handler)]))
  registerConfigRoutes(app as never)
  const res = { json: vi.fn() }
  await routes.get('post /api/config')!({ body: { imChannels: { instances: [] } }, query }, res)
  return res.json.mock.calls[0][0]
}

describe('POST /api/config', () => {
  beforeEach(() => {
    setConfig.mockClear()
  })

  it('hands the stamp to the save', async () => {
    await postConfig({ snapshotEpoch: '3' })
    expect(setConfig).toHaveBeenCalledWith({ imChannels: { instances: [] } }, 3)

    await postConfig({ snapshotEpoch: '-1' })
    expect(setConfig).toHaveBeenLastCalledWith({ imChannels: { instances: [] } }, -1)
  })

  it('treats a missing or malformed stamp as none', async () => {
    await postConfig({})
    await postConfig({ snapshotEpoch: 'latest' })
    await postConfig({ snapshotEpoch: ['1', '2'] })

    for (const call of setConfig.mock.calls) expect(call[1]).toBeUndefined()
  })
})
