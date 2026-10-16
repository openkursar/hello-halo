/**
 * The two routes that write a member's delegated policy — adding a member and
 * rewriting one — store it as sent, and it is later read as permissions. Both
 * pass a well-formed policy through and refuse anything else before it is
 * stored; rewriting also accepts null, which clears it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

vi.mock('../../../../src/main/http/auth/middleware', () => ({ getOfficeCredential: () => null }))

const addMember = vi.fn<[string, unknown], Promise<unknown>>()
const updateMember = vi.fn<[string, string, unknown], unknown>()
vi.mock('../../../../src/main/apps/team', () => ({
  getTeamService: () => ({
    addMember: (teamId: string, input: unknown) => addMember(teamId, input),
    updateMember: (teamId: string, appId: string, input: unknown) => updateMember(teamId, appId, input),
  }),
  getTeamStore: () => null,
}))
vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({ readTeamMemberHistory: () => [] }))
vi.mock('../../../../src/main/apps/runtime/federation/manager', () => ({ getFederationManager: () => null }))
vi.mock('../../../../src/main/services/agent', () => ({ formatReferencesBlock: () => '', getWorkingDir: () => '' }))

import { registerTeamRoutes } from '../../../../src/main/http/routes/team.routes'
import { capabilityPolicyFromPreset } from '../../../../src/shared/apps/capability-policy'

async function send(
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
): Promise<{ status: number; json: { success: boolean; error?: string } }> {
  const app = express()
  app.use(express.json())
  registerTeamRoutes(app)
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const add = (body: unknown) => send('POST', '/api/teams/team-1/members', body)
const rewrite = (body: unknown) => send('PATCH', '/api/teams/team-1/members/app-1', body)

const MALFORMED: [string, unknown][] = [
  ['a list', ['Read']],
  ['a tool list written as one string', { allowedTools: 'Read,Write' }],
  ['a list holding a non-string', { allowedTools: ['Read', 7] }],
  ['a switch that is not a boolean', { allowAiBrowser: 'yes' }],
  ['an unknown command scope', { bashScope: 'some' }],
  ['a field nobody reads', { allowEverything: true }],
]

beforeEach(() => {
  addMember.mockReset()
  addMember.mockResolvedValue({ appId: 'app-1' })
  updateMember.mockReset()
  updateMember.mockReturnValue({ appId: 'app-1' })
})

describe('adding a member with the answer for other computers', () => {
  it('passes a preset through untouched, periodic-check answer included', async () => {
    const delegatedPolicy = { ...capabilityPolicyFromPreset('read_only'), allowChecks: false }

    const res = await add({ appId: 'app-1', delegatedPolicy })

    expect(res.status).toBe(200)
    expect(addMember).toHaveBeenCalledWith('team-1', { appId: 'app-1', delegatedPolicy })
  })

  it('leaves the choice to the service when none is sent', async () => {
    const res = await add({ appId: 'app-1' })

    expect(res.status).toBe(200)
    expect(addMember).toHaveBeenCalledWith('team-1', { appId: 'app-1' })
  })

  it.each([...MALFORMED, ['null', null]])('refuses %s without storing anything', async (_label, delegatedPolicy) => {
    const res = await add({ appId: 'app-1', delegatedPolicy })

    expect(res.status).toBe(400)
    expect(res.json).toEqual({ success: false, error: 'Invalid field: delegatedPolicy' })
    expect(addMember).not.toHaveBeenCalled()
  })
})

describe('rewriting what a member of yours lends', () => {
  it('passes a policy through untouched', async () => {
    const delegatedPolicy = { ...capabilityPolicyFromPreset('workspace'), allowedSkills: ['pdf'] }

    const res = await rewrite({ delegatedPolicy })

    expect(res.status).toBe(200)
    expect(updateMember).toHaveBeenCalledWith('team-1', 'app-1', { delegatedPolicy })
  })

  it('accepts null, which clears it, and a duty-only change', async () => {
    expect((await rewrite({ delegatedPolicy: null })).status).toBe(200)
    expect((await rewrite({ duty: 'You test things.' })).status).toBe(200)
    expect(updateMember).toHaveBeenNthCalledWith(1, 'team-1', 'app-1', { delegatedPolicy: null })
    expect(updateMember).toHaveBeenNthCalledWith(2, 'team-1', 'app-1', { duty: 'You test things.' })
  })

  it.each(MALFORMED)('refuses %s without storing anything', async (_label, delegatedPolicy) => {
    const res = await rewrite({ delegatedPolicy })

    expect(res.status).toBe(400)
    expect(res.json).toEqual({ success: false, error: 'Invalid field: delegatedPolicy' })
    expect(updateMember).not.toHaveBeenCalled()
  })
})
