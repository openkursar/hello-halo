/**
 * Unit tests for runtime/team/checks — periodic checks.
 *
 * Covers the promises the product makes about them: the alarm is armed only on
 * the machine that owns the target; a due check wakes with who-set-it, the
 * original words and the round number; a busy target is skipped rather than
 * queued; anyone can stop one; the check ends with the work it belongs to; and
 * an owner that declines checks cannot be given one from anywhere.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTeamChecks, TEAM_CHECK_JOB_KIND, TeamCheckError } from '../../../../../src/main/apps/runtime/team/checks'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/team/migrations'
import { SELF_NODE_ID } from '../../../../../src/shared/apps/team-types'
import type { TeamCheck } from '../../../../../src/shared/apps/team-types'
import type { JobDueHandler } from '../../../../../src/main/platform/scheduler'
import type { WakeDisposition } from '../../../../../src/main/apps/runtime/team/message-bus'

const TEAM = 'team-1'
const EPOCH = 'epoch-1'
const SETTER = 'app-reviewer'
const TARGET = 'app-bugfixer'
const REMOTE = 'app-remote'

function makeStore(): TeamStore {
  const dbm = createDatabaseManager(':memory:')
  const db = dbm.getAppDatabase()
  dbm.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  const store = new TeamStore(db)

  store.insertTeam({
    id: TEAM, name: 'Delivery', owningSpaceId: 'space', goal: 'ship',
    leadAppId: SETTER, memberSourcing: 'manual', collabMode: 'free',
    escalationRouting: 'user', status: 'running', currentEpochId: EPOCH,
    createdAt: 1, updatedAt: 1,
  })
  store.insertEpoch({
    id: EPOCH, teamId: TEAM, startedAt: 1, endedAt: null, endReason: null,
    summary: null, lifecycle: 'run',
  })
  store.addMember({ teamId: TEAM, appId: SETTER, memberName: 'reviewer', role: '', isLead: true, aiProvisioned: false, addedAt: 1 })
  store.addMember({ teamId: TEAM, appId: TARGET, memberName: 'bugfixer', role: '', isLead: false, aiProvisioned: false, addedAt: 2 })
  store.addMember({
    teamId: TEAM, appId: REMOTE, memberName: 'tester', role: '', isLead: false,
    aiProvisioned: false, addedAt: 3, ownerNodeId: 'node-b', origin: 'remote',
  })
  return store
}

function makeHarness(store: TeamStore, opts?: { busy?: boolean; wake?: WakeDisposition }) {
  const jobs = new Map<string, any>()
  let due: JobDueHandler | null = null
  const scheduler = {
    addJob: vi.fn((j: any) => { jobs.set(j.id, j); return j.id }),
    removeJob: vi.fn((id: string) => { jobs.delete(id) }),
    getJob: vi.fn((id: string) => jobs.get(id) ?? null),
    listJobs: vi.fn(() => [...jobs.values()]),
    onJobDue: vi.fn((kind: string, handler: JobDueHandler) => { if (kind === TEAM_CHECK_JOB_KIND) due = handler }),
  } as any

  const wakes: { appId: string; body: string; onBusy: string }[] = []
  const published: { op: string; check: TeamCheck }[] = []
  const checks = createTeamChecks({
    store,
    scheduler,
    wake: async (p) => {
      wakes.push({ appId: p.appId, body: p.body, onBusy: p.onBusy })
      return opts?.wake ?? 'dispatched'
    },
    isBusy: () => opts?.busy ?? false,
    publish: (change) => { published.push({ op: change.op, check: change.check }) },
  })
  checks.registerHandler()
  return {
    checks,
    jobs,
    wakes,
    published,
    scheduler,
    fireDue: (checkId: string) => due!({ id: `team-check:${checkId}`, metadata: { checkId, teamId: TEAM } } as any),
  }
}

function baseInput() {
  return {
    teamId: TEAM,
    epochId: EPOCH,
    createdByAppId: SETTER,
    targetAppId: TARGET,
    instruction: 'Look for open bugs and fix them.',
    schedule: { kind: 'every', every: '30m' } as const,
  }
}

describe('team periodic checks', () => {
  let store: TeamStore

  beforeEach(() => { store = makeStore() })

  it('arms an alarm for a member this machine owns and shares the row', () => {
    const h = makeHarness(store)
    const check = h.checks.schedule(baseInput())

    expect(h.jobs.get(`team-check:${check.id}`)).toMatchObject({
      kind: TEAM_CHECK_JOB_KIND,
      schedule: { kind: 'every', every: '30m' },
      metadata: { checkId: check.id, teamId: TEAM },
    })
    expect(h.published).toEqual([{ op: 'upsert', check }])
    expect(store.getCheckById(check.id)).toMatchObject({ targetAppId: TARGET, runCount: 0 })
  })

  it('records a check on a teammate’s member without arming an alarm here', () => {
    const h = makeHarness(store)
    const check = h.checks.schedule({ ...baseInput(), targetAppId: REMOTE })

    expect(h.jobs.size).toBe(0)
    expect(store.getCheckById(check.id)).not.toBeNull()
    expect(h.published).toEqual([{ op: 'upsert', check }])
  })

  it('refuses a member whose owner does not accept periodic checks', () => {
    store.updateMemberFields(TEAM, TARGET, { acceptsChecks: false })
    const h = makeHarness(store)

    expect(() => h.checks.schedule(baseInput())).toThrow(TeamCheckError)
    expect(store.listChecksByEpoch(TEAM, EPOCH)).toHaveLength(0)
  })

  it('refuses a schedule that can never fire', () => {
    const h = makeHarness(store)
    expect(() => h.checks.schedule({ ...baseInput(), schedule: { kind: 'every', every: 'soon' } as never }))
      .toThrow(TeamCheckError)
    expect(() => h.checks.schedule({ ...baseInput(), schedule: { kind: 'once', once: 1 } }))
      .toThrow(TeamCheckError)
  })

  it('wakes the target with who set it, the original words and the round number', async () => {
    const h = makeHarness(store)
    const check = h.checks.schedule(baseInput())

    expect(await h.fireDue(check.id)).toBe('useful')
    expect(h.wakes).toHaveLength(1)
    expect(h.wakes[0].appId).toBe(TARGET)
    expect(h.wakes[0].onBusy).toBe('skip')
    expect(h.wakes[0].body).toContain('set by reviewer')
    expect(h.wakes[0].body).toContain('run #1')
    expect(h.wakes[0].body).toContain('Look for open bugs and fix them.')
    expect(store.getCheckById(check.id)!.runCount).toBe(1)

    expect(await h.fireDue(check.id)).toBe('useful')
    expect(h.wakes[1].body).toContain('run #2')
  })

  it('skips the round when the target is mid-turn instead of queueing it', async () => {
    const h = makeHarness(store, { busy: true })
    const check = h.checks.schedule(baseInput())

    expect(await h.fireDue(check.id)).toBe('skipped')
    expect(h.wakes).toHaveLength(0)
    expect(store.getCheckById(check.id)!.runCount).toBe(0)
  })

  it('does not count a round the bus skipped after this module let it through', async () => {
    // The bus applies the busy rule one layer down and also sees wakes already in
    // flight, so it can skip a round this module thought was going ahead. The
    // round number and lastRunAt are what the panel and the agent read, so an
    // unrun round must leave no trace.
    const h = makeHarness(store, { wake: 'skipped' })
    const check = h.checks.schedule(baseInput())
    const publishedOnSchedule = h.published.length

    expect(await h.fireDue(check.id)).toBe('skipped')
    expect(h.wakes).toHaveLength(1)
    expect(store.getCheckById(check.id)).toMatchObject({ runCount: 0, lastRunAt: null })
    expect(h.published).toHaveLength(publishedOnSchedule)

    // The next round reuses the number, so the target never sees a gap.
    const dispatching = makeHarness(store)
    expect(await dispatching.fireDue(check.id)).toBe('useful')
    expect(dispatching.wakes[0].body).toContain('run #1')
    expect(store.getCheckById(check.id)!.runCount).toBe(1)
  })

  it('retires a one-shot once it has been handed over', async () => {
    const h = makeHarness(store)
    const check = h.checks.schedule({ ...baseInput(), schedule: { kind: 'once', once: Date.now() + 60_000 } })

    expect(await h.fireDue(check.id)).toBe('useful')
    expect(h.wakes).toHaveLength(1)
    // Nothing stands over the member any more: the row is what every board
    // reads, and leaving it would keep offering to stop something that is over.
    expect(store.getCheckById(check.id)).toBeNull()
    expect(h.published.at(-1)).toMatchObject({ op: 'delete' })
    // The alarm is the scheduler's to retire — a job cannot be deleted from
    // inside its own run without breaking the run log written on the way out.
    expect(h.jobs.has(`team-check:${check.id}`)).toBe(true)
  })

  it('queues a one-shot on a busy target instead of losing its only round', async () => {
    const h = makeHarness(store, { busy: true, wake: 'buffered' })
    const check = h.checks.schedule({ ...baseInput(), schedule: { kind: 'once', once: Date.now() + 60_000 } })

    expect(await h.fireDue(check.id)).toBe('useful')
    expect(h.wakes).toHaveLength(1)
    expect(h.wakes[0].onBusy).toBe('buffer')
    expect(store.getCheckById(check.id)).toBeNull()
  })

  it('sweeps alarms whose check is gone when re-arming after a restart', () => {
    const first = makeHarness(store)
    const check = first.checks.schedule(baseInput())
    // What a retired one-shot leaves behind: the job outlives its check.
    store.deleteCheck(check.id)

    const restarted = makeHarness(store)
    restarted.jobs.set(`team-check:${check.id}`, first.jobs.get(`team-check:${check.id}`))
    restarted.checks.rehydrate()

    expect(restarted.jobs.size).toBe(0)
  })

  it('lets any member stop a check someone else set', () => {
    const h = makeHarness(store)
    const check = h.checks.schedule(baseInput())

    const stopped = h.checks.cancel({ teamId: TEAM, epochId: EPOCH, targetAppId: TARGET })

    expect(stopped.map(c => c.id)).toEqual([check.id])
    expect(store.getCheckById(check.id)).toBeNull()
    expect(h.jobs.size).toBe(0)
    expect(h.published.at(-1)).toMatchObject({ op: 'delete' })
  })

  it('stops every check on one member when no id is given', () => {
    const h = makeHarness(store)
    h.checks.schedule(baseInput())
    h.checks.schedule({ ...baseInput(), instruction: 'Also watch the release notes.' })

    expect(h.checks.cancel({ teamId: TEAM, epochId: EPOCH, targetAppId: TARGET })).toHaveLength(2)
    expect(store.listChecksByEpoch(TEAM, EPOCH)).toHaveLength(0)
  })

  it('ends every check when the work it belongs to ends', () => {
    const h = makeHarness(store)
    h.checks.schedule(baseInput())
    h.checks.schedule({ ...baseInput(), targetAppId: REMOTE })

    h.checks.clearEpoch(TEAM, EPOCH)

    expect(store.listChecksByEpoch(TEAM, EPOCH)).toHaveLength(0)
    expect(h.jobs.size).toBe(0)
  })

  it('drops a check whose work already ended when its alarm rings', async () => {
    const h = makeHarness(store)
    const check = h.checks.schedule(baseInput())
    store.endEpoch(EPOCH, Date.now(), 'completed', null)

    expect(await h.fireDue(check.id)).toBe('skipped')
    expect(store.getCheckById(check.id)).toBeNull()
    expect(h.wakes).toHaveLength(0)
  })

  it('arms a replicated check locally without re-publishing it', () => {
    const h = makeHarness(store)
    const replicated: TeamCheck = {
      id: 'check-from-elsewhere', teamId: TEAM, epochId: EPOCH,
      targetAppId: TARGET, createdByAppId: REMOTE,
      instruction: 'Watch the release plan.',
      schedule: { kind: 'every', every: '1h' },
      runCount: 0, createdAt: 1, updatedAt: 1, lastRunAt: null,
    }

    h.checks.applyReplicated(replicated)

    expect(store.getCheckById(replicated.id)).not.toBeNull()
    expect(h.jobs.has(`team-check:${replicated.id}`)).toBe(true)
    expect(h.published).toHaveLength(0)
  })

  it('withdraws a replicated check aimed at a member of mine that declines them', () => {
    store.updateMemberFields(TEAM, TARGET, { acceptsChecks: false })
    const h = makeHarness(store)
    const replicated: TeamCheck = {
      id: 'unwanted', teamId: TEAM, epochId: EPOCH,
      targetAppId: TARGET, createdByAppId: REMOTE,
      instruction: 'Keep an eye out.',
      schedule: { kind: 'every', every: '1h' },
      runCount: 0, createdAt: 1, updatedAt: 1, lastRunAt: null,
    }

    h.checks.applyReplicated(replicated)

    expect(store.getCheckById('unwanted')).toBeNull()
    expect(h.published.at(-1)).toMatchObject({ op: 'delete' })
  })

  it('re-arms only the alarms it owns after a restart, dropping finished ones', () => {
    const first = makeHarness(store)
    const mine = first.checks.schedule(baseInput())
    const theirs = first.checks.schedule({ ...baseInput(), targetAppId: REMOTE })

    const stale = { ...mine, id: 'stale', epochId: 'gone-epoch' }
    store.upsertCheck(stale)

    const restarted = makeHarness(store)
    restarted.checks.rehydrate()

    expect(restarted.jobs.has(`team-check:${mine.id}`)).toBe(true)
    expect(restarted.jobs.has(`team-check:${theirs.id}`)).toBe(false)
    expect(store.getCheckById('stale')).toBeNull()
  })

  it('reports a check for the board with names resolved and its round count', () => {
    const h = makeHarness(store)
    const check = h.checks.schedule(baseInput())

    const [view] = h.checks.viewForEpoch(TEAM, EPOCH)
    expect(view).toMatchObject({
      id: check.id,
      targetMemberName: 'bugfixer',
      createdByMemberName: 'reviewer',
      runCount: 0,
      reachable: true,
    })
  })

  it('reports a check on an offline teammate as not running', () => {
    const store2 = makeStore()
    const checks = createTeamChecks({
      store: store2,
      wake: async () => 'dispatched',
      isBusy: () => false,
      isReachable: (appId) => appId !== REMOTE,
    })
    checks.schedule({ ...baseInput(), targetAppId: REMOTE })

    const [view] = checks.viewForEpoch(TEAM, EPOCH)
    expect(view.reachable).toBe(false)
    expect(view.targetOwner).toBeDefined()
  })

  it('treats a member stored SELF-relative as locally owned', () => {
    const member = store.listMembersByTeam(TEAM).find(m => m.appId === TARGET)!
    expect(member.ownerNodeId).toBe(SELF_NODE_ID)
  })
})
