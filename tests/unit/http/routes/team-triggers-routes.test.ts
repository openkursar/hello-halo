/**
 * The team trigger write is one handler behind two listeners. Halo's own
 * clients reach it as they always did, a webhook included; an assistant session
 * reaches it through the self-API's withheld-field check, which refuses a
 * webhook before the handler runs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

vi.mock('../../../../src/main/http/auth/middleware', () => ({ getOfficeCredential: () => null }))

const setTrigger = vi.fn<[string, unknown, string | undefined], unknown>()
vi.mock('../../../../src/main/apps/team', () => ({
  getTeamService: () => ({
    setTrigger: (teamId: string, trigger: unknown, triggerId?: string) => setTrigger(teamId, trigger, triggerId),
  }),
  getTeamStore: () => null,
}))
vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({ readTeamMemberHistory: () => [] }))
vi.mock('../../../../src/main/apps/runtime/federation/manager', () => ({ getFederationManager: () => null }))
vi.mock('../../../../src/main/services/agent', () => ({ formatReferencesBlock: () => '', getWorkingDir: () => '' }))

import { registerTeamRoutes } from '../../../../src/main/http/routes/team.routes'
import { rejectWithheldFields } from '../../../../src/main/http/self-api/withheld-fields'

const webhook = { sourceType: 'webhook', config: { path: 'deploys', secret: 's3cret' }, enabled: true }

async function postTrigger(listener: 'halo' | 'assistant', body: unknown) {
  const app = express()
  app.use(express.json())
  // Mounted as the self-API server mounts it; Halo's own listener has no such check.
  if (listener === 'assistant') app.use('/api', rejectWithheldFields)
  registerTeamRoutes(app)
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/teams/team-1/triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() as Record<string, unknown> }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

beforeEach(() => {
  setTrigger.mockReset()
  setTrigger.mockImplementation((teamId, trigger) => ({ id: 'trg-1', teamId, ...(trigger as object) }))
})

describe('a team webhook trigger', () => {
  it('is added and changed for Halo\u2019s own clients as before', async () => {
    expect((await postTrigger('halo', { trigger: webhook })).json).toMatchObject({ success: true })
    expect((await postTrigger('halo', { trigger: { ...webhook, enabled: false }, triggerId: 'trg-1' })).status).toBe(200)
    expect(setTrigger.mock.calls).toEqual([
      ['team-1', webhook, undefined],
      ['team-1', { ...webhook, enabled: false }, 'trg-1'],
    ])
  })

  it('is refused to an assistant session before the handler runs, where a schedule goes through', async () => {
    const refused = await postTrigger('assistant', { trigger: webhook })
    expect(refused.status).toBe(400)
    expect(refused.json).toMatchObject({ code: 'halo.self_api.field_not_accepted', value: 'webhook' })
    expect(setTrigger).not.toHaveBeenCalled()

    const schedule = { sourceType: 'schedule', config: { every: '1h' } }
    expect((await postTrigger('assistant', { trigger: schedule })).json).toMatchObject({ success: true })
    expect(setTrigger).toHaveBeenCalledWith('team-1', schedule, undefined)
  })
})
