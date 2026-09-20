import { describe, expect, it } from 'vitest'
import { activitySourceKind, isPendingDecision, mergeActivityEntries, visibleDigitalHumans } from '../../../src/renderer/utils/people-model'
import type { ActivityEntry, InstalledApp } from '../../../src/shared/apps/app-types'
import type { TeamListItem } from '../../../src/shared/apps/team-types'

const decision = (id: string, patch: Partial<ActivityEntry> = {}): ActivityEntry => ({ id, appId: 'person', runId: `run-${id}`, type: 'escalation', ts: 1, content: { summary: 'Question' }, ...patch })

describe('digital human work projection', () => {
  it('keeps human-created team leaders and names containing Lead visible', () => {
    const apps = ['system', 'owner', 'Lead researcher'].map(id => ({ id, spec: { type: 'automation' } }) as InstalledApp)
    const teams = [{ localMembers: [{ appId: 'system', isLead: true, isSystemCoordinator: true }, { appId: 'owner', isLead: true, isSystemCoordinator: false }] }] as TeamListItem[]
    expect(visibleDigitalHumans(apps, teams).map(app => app.id)).toEqual(['owner', 'Lead researcher'])
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
