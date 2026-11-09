import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'

const run = vi.hoisted(() => vi.fn())
vi.mock('../../../../src/main/http/auth/middleware', () => ({ getOfficeCredential: () => null }))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamService: () => ({ runTeam: run }), getTeamStore: () => null }))
vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({ readTeamMemberHistory: () => [] }))
vi.mock('../../../../src/main/apps/runtime/federation/manager', () => ({ getFederationManager: () => null }))
vi.mock('../../../../src/main/services/agent', () => ({ formatReferencesBlock: () => '', getWorkingDir: () => '' }))
import { registerTeamRoutes } from '../../../../src/main/http/routes/team.routes'

async function start(body: unknown) {
  const app = express()
  app.use(express.json())
  registerTeamRoutes(app)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/teams/team/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}
beforeEach(() => { run.mockReset(); run.mockResolvedValue({ epochId: 'accepted-work' }) })

describe('explicit team work creation', () => {
  it('returns the created work instead of asking callers to guess the latest team pointer', async () => {
    expect(await start({ instruction: 'Review this issue.', trigger: { type: 'manual' } })).toEqual({
      status: 200, body: { success: true, data: { epochId: 'accepted-work' } },
    })
    expect(run).toHaveBeenCalledWith('team', { type: 'manual' }, 'Review this issue.')
  })
  it('retains the automatic HTTP-trigger guard when no manual trigger was specified', async () => {
    await start({})
    expect(run).toHaveBeenCalledWith('team', { type: 'http' }, undefined)
  })
  it('rejects malformed instructions before creating work', async () => {
    expect((await start({ instruction: [] })).status).toBe(400)
    expect((await start({ trigger: { type: 'schedule' } })).status).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })
})
