import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../../src/main/apps/manager', async () => ({
  getAppManager: () => null,
  getPersonConnectionAccess: (await import('../../../../src/main/apps/manager/capability-inventory')).getPersonConnectionAccess,
}))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamStore: () => null }))
vi.mock('../../../../src/main/apps/skill-discovery', () => ({ listAvailableSkills: () => [] }))
import { queryPersonContext } from '../../../../src/main/apps/runtime/person-context'
import type { InstalledApp } from '../../../../src/main/apps/manager'
import type { Team, TeamMember } from '../../../../src/shared/apps/team-types'

function fixtures(count = 2) {
  const app = {
    id: 'person', spaceId: 'space', status: 'active',
    spec: { type: 'automation', name: 'Analyst', description: 'Research', requires: { mcps: [{ id: 'crm', enabled: false }, { id: 'missing' }] } },
  } as InstalledApp
  const members = Array.from({ length: count }, (_, index) => ({
    appId: 'person', teamId: `team-${index}`, role: 'Analyst', duty: 'Check facts', isLead: false, aiProvisioned: false, addedAt: 1,
  } as TeamMember))
  return {
    manager: {
      getApp: vi.fn((id: string) => id === 'person' ? app : null),
      listEffectiveMcpApps: vi.fn(() => [{ id: 'crm-app', specId: 'crm', spaceId: null, status: 'active', spec: { name: 'CRM', type: 'mcp', mcp_server: { transport: 'http', url: 'https://example.invalid/mcp' }, config_schema: [] }, userConfig: { secret: 'never-return' } }] as unknown as InstalledApp[]),
    },
    teams: {
      listMembersByAppId: vi.fn(() => members),
      getTeamById: vi.fn((id: string) => ({ id, name: id, updatedAt: 7, hostNodeId: id === 'team-1' ? 'remote' : null } as Team)),
      getEpochById: vi.fn((id: string) => ({ id, teamId: 'team-0', startedAt: 1, endedAt: null, endReason: null, summary: 'Shared work summary', lifecycle: 'conversation' as const, title: 'Review' })),
    },
    skills: vi.fn(() => [{ name: 'Audit', scope: 'global' as const, description: '', dirName: 'audit', path: '/private/path', content: 'private skill body' }]),
    now: () => 100,
  }
}

describe('authorized person context', () => {
  it('reads fresh owner relationships and returns structured references without histories', () => {
    const deps = fixtures()
    const result = queryPersonContext({ authority: 'owner', appId: 'person' }, { section: 'teams' }, deps)
    expect(result.teams).toHaveLength(2)
    expect(result.teams?.[1].availability).toBe('last_synced')
    expect(result.references[0]).toEqual({ kind: 'team', teamId: 'team-0', appId: 'person', label: 'team-0' })
    expect(deps.teams.getEpochById).not.toHaveBeenCalled()
    expect(deps.skills).not.toHaveBeenCalled()
    deps.teams.listMembersByAppId.mockReturnValue([])
    expect(queryPersonContext({ authority: 'owner', appId: 'person' }, { section: 'teams' }, deps).teams).toEqual([])
  })

  it('bounds relationship results and supplies a next page', () => {
    const deps = fixtures(25)
    const first = queryPersonContext({ authority: 'owner' }, { appId: 'person', section: 'teams' }, deps)
    const next = queryPersonContext({ authority: 'owner' }, { appId: 'person', section: 'teams', offset: first.nextOffset }, deps)
    expect(first.teams).toHaveLength(20)
    expect(next.teams).toHaveLength(5)
    expect(new Set([...first.references, ...next.references].map(ref => ref.teamId)).size).toBe(25)
  })

  it('denies guests before accessing relationship data', () => {
    const deps = fixtures()
    expect(() => queryPersonContext({ authority: 'guest', appId: 'person' }, { section: 'teams' }, deps)).toThrow('cannot read')
    expect(deps.teams.listMembersByAppId).not.toHaveBeenCalled()
  })

  it('does not let a bound human or teammate query another identity', () => {
    expect(() => queryPersonContext({ authority: 'owner', appId: 'person' }, { section: 'teams', appId: 'other' }, fixtures())).toThrow('another digital human')
  })

  it('limits team calls to current membership and rechecks revoked membership', () => {
    const deps = fixtures()
    const caller = { authority: 'team' as const, appId: 'person', teamId: 'team-0', epochId: 'task-0' }
    expect(queryPersonContext(caller, { section: 'teams' }, deps).teams?.map(team => team.teamId)).toEqual(['team-0'])
    expect(() => queryPersonContext(caller, { section: 'work', teamId: 'team-1', epochId: 'task-0' }, deps)).toThrow('permitted team')
    expect(() => queryPersonContext(caller, { section: 'work', epochId: 'other-task' }, deps)).toThrow('current task')
    deps.teams.listMembersByAppId.mockReturnValue([])
    expect(() => queryPersonContext(caller, { section: 'teams' }, deps)).toThrow('no longer available')
  })

  it('returns task identity without private transcripts and rejects mismatched teams', () => {
    const deps = fixtures()
    const result = queryPersonContext({ authority: 'owner', appId: 'person' }, { section: 'work', teamId: 'team-0', epochId: 'task-0' }, deps)
    expect(result.references[0].epochId).toBe('task-0')
    expect(result.work?.summary).toBe('Shared work summary')
    expect(result.work?.status).toBe('unknown')
    expect(() => queryPersonContext({ authority: 'owner', appId: 'person' }, { section: 'work', teamId: 'team-1', epochId: 'task-0' }, deps)).toThrow('unavailable')
  })

  it('does not describe a sealed execution as completed business work', () => {
    const deps = fixtures()
    deps.teams.getEpochById.mockReturnValue({ id: 'task-0', teamId: 'team-0', startedAt: 1, endedAt: 9, endReason: 'error', summary: '', lifecycle: 'conversation', title: 'Review' } as never)
    const result = queryPersonContext({ authority: 'owner', appId: 'person' }, { section: 'work', teamId: 'team-0', epochId: 'task-0' }, deps)
    expect(result.work?.status).toBe('unknown')
  })

  it('reports disabled and missing connections honestly without credentials or skill bodies', () => {
    const result = queryPersonContext({ authority: 'owner', appId: 'person' }, { section: 'capabilities' }, fixtures())
    expect(result.capabilities?.connections).toEqual([
      { specId: 'crm', instanceId: 'crm-app', name: 'CRM', declared: true, enabled: false, installed: true, configured: true, health: 'not_checked', chatAccess: false, automationAccess: false },
      { specId: 'missing', instanceId: undefined, name: 'missing', declared: true, enabled: true, installed: false, configured: false, health: 'not_checked', chatAccess: false, automationAccess: false },
    ])
    expect(JSON.stringify(result)).not.toMatch(/never-return|private\/path|private skill body/)
    expect(() => queryPersonContext({ authority: 'team', appId: 'person', teamId: 'team-0' }, { section: 'capabilities' }, fixtures())).toThrow('Only the owner')
  })
})
