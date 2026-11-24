import { describe, expect, it } from 'vitest'
import { activitySourceKind, coordinatorIds, ephemeralMemberIds, isPendingDecision, mergeActivityEntries, pickableDigitalHumans, teamMemberCandidates, visibleDigitalHumans } from '../../../src/renderer/utils/people-model'
import type { ActivityEntry, InstalledApp } from '../../../src/shared/apps/app-types'
import type { TeamListItem } from '../../../src/shared/apps/team-types'

const decision = (id: string, patch: Partial<ActivityEntry> = {}): ActivityEntry => ({ id, appId: 'person', runId: `run-${id}`, type: 'escalation', ts: 1, content: { summary: 'Question' }, ...patch })

describe('digital human work projection', () => {
  it('lists every team leader, and withholds only what an ephemeral collaboration built', () => {
    const apps = ['system', 'owner', 'Lead researcher', 'throwaway'].map(id => ({ id, spec: { type: 'automation' } }) as InstalledApp)
    const teams = [
      { localMembers: [{ appId: 'system', isLead: true, isSystemCoordinator: true }, { appId: 'owner', isLead: true, isSystemCoordinator: false }] },
      { ephemeral: true, localMembers: [{ appId: 'throwaway', isLead: false, isSystemCoordinator: false }] },
    ] as TeamListItem[]
    expect(visibleDigitalHumans(apps, teams).map(app => app.id)).toEqual(['system', 'owner', 'Lead researcher'])
  })
  it('keeps coordinators out of the recipients a person addresses directly', () => {
    const teams = [
      { localMembers: [{ appId: 'system', isLead: true, isSystemCoordinator: true }, { appId: 'owner', isLead: true, isSystemCoordinator: false }] },
      { ephemeral: true, localMembers: [{ appId: 'throwaway', isLead: false, isSystemCoordinator: false }] },
    ] as TeamListItem[]
    expect([...coordinatorIds(teams)]).toEqual(['system'])
    expect([...ephemeralMemberIds(teams)]).toEqual(['throwaway'])
  })
  it('keeps listing a collaboration member once the collaboration is saved as a team', () => {
    const teams = [
      { ephemeral: true, localMembers: [{ appId: 'kept', isLead: false }, { appId: 'throwaway', isLead: false }] },
      { localMembers: [{ appId: 'saved-lead', isLead: true }, { appId: 'kept', isLead: false }] },
    ] as TeamListItem[]
    expect([...ephemeralMemberIds(teams)]).toEqual(['throwaway'])
  })
  it('offers for new work only listed, installed digital humans, and never a lead as a team member', () => {
    const app = (id: string, status: InstalledApp['status'] = 'active', type = 'automation') => ({ id, status, spec: { type } }) as InstalledApp
    const apps = [app('own'), app('paused', 'paused'), app('removed', 'uninstalled'), app('throwaway'), app('lead'), app('skill', 'active', 'skill')]
    const teams = [
      { leadAppId: 'lead', localMembers: [{ appId: 'lead', isLead: true }] },
      { ephemeral: true, localMembers: [{ appId: 'throwaway', isLead: false }] },
    ] as TeamListItem[]
    expect(pickableDigitalHumans(apps, teams).map(a => a.id)).toEqual(['own', 'paused', 'lead'])
    expect(teamMemberCandidates(apps, teams).map(a => a.id)).toEqual(['own', 'paused'])
  })
  it('never infers an unknown historical source from its text or available team', () => {
    expect(activitySourceKind(decision('old', { content: { summary: 'Team finance asked me' } }))).toBe('unknown')
    expect(activitySourceKind(decision('team', { content: { summary: 'Hello', teamContext: { teamId: 't', epochId: 'e' } } }))).toBe('team')
    expect(activitySourceKind(decision('solo', { content: { summary: 'Team finance', source: { kind: 'automation', appId: 'person' } } }))).toBe('automation')
  })
  it('a multi-question request is one pending record and closure is never an answer', () => {
    const multi = decision('multiple', { content: { summary: 'Two decisions', questions: [{ question: 'One' }, { question: 'Two' }] } })
    const expired = decision('expired', { content: { summary: 'Old', resolution: { reason: 'expired', ts: 3 } } })
    expect([multi, expired, decision('answered', { userResponse: { ts: 2, text: 'Yes' } })].filter(isPendingDecision)).toEqual([multi])
    expect(expired.userResponse).toBeUndefined()
  })
  it('canonical answer and continuation updates replace the same card without changing original chronology', () => {
    const old = decision('a')
    const recent = decision('b', { ts: 10 })
    const answered = { ...old, userResponse: { ts: 20, text: 'Approved' }, continuation: { status: 'queued' as const, attempts: 0, updatedAt: 20 } }
    const merged = mergeActivityEntries([recent, old], [answered, answered])
    expect(merged.map(entry => entry.id)).toEqual(['b', 'a'])
    expect(merged[1].continuation?.status).toBe('queued')
    expect(merged.filter(isPendingDecision).map(entry => entry.id)).toEqual(['b'])
  })
})
