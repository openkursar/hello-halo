/**
 * Unit tests for the exported team record.
 *
 * It exists so that bounding a board read costs the agent nothing permanent: the
 * acts left out of the window stay reachable. The tests pin that reach, and the
 * three properties that keep it a printout rather than a second ledger — written
 * only when something is actually withheld, rewritten only when the record moved,
 * and rebuilt whole (never appended) so an act replicated in late cannot land out
 * of order or twice.
 *
 * They also pin the two ways a printout could disagree with what the reader was
 * told about it, both silent: a second instance on the same machine writing over
 * it, and a reader opening it mid-rewrite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync, readdirSync } from 'fs'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/team/migrations'
import { createBoardArchive } from '../../../../../src/main/apps/runtime/team/board-archive'
import type { Team, TeamMember, TeamEpoch } from '../../../../../src/main/apps/team/types'

const TEAM_ID = 'team-1'
const EPOCH_ID = 'epoch-1'
const LEAD_APP = 'app-lead'
const RESEARCHER_APP = 'app-researcher'

function seed(store: TeamStore): void {
  const now = Date.now()
  const team: Team = {
    id: TEAM_ID,
    name: 'Research Team',
    owningSpaceId: 'space-a',
    goal: 'goal',
    leadAppId: LEAD_APP,
    memberSourcing: 'manual',
    collabMode: 'free',
    escalationRouting: 'user',
    status: 'running',
    currentEpochId: EPOCH_ID,
    createdAt: now,
    updatedAt: now,
  }
  store.insertTeam(team)
  const members: TeamMember[] = [
    { teamId: TEAM_ID, appId: LEAD_APP, memberName: 'lead', role: 'Lead', isLead: true, aiProvisioned: false, addedAt: now },
    { teamId: TEAM_ID, appId: RESEARCHER_APP, memberName: 'researcher', role: 'Research', isLead: false, aiProvisioned: false, addedAt: now },
  ]
  for (const m of members) store.addMember(m)
  const epoch: TeamEpoch = {
    id: EPOCH_ID, teamId: TEAM_ID, startedAt: now, endedAt: null,
    endReason: null, summary: null, lifecycle: 'run',
  }
  store.insertEpoch(epoch)
}

function addActs(store: TeamStore, count: number, from = 0): void {
  for (let i = from; i < from + count; i++) {
    store.insertActivity({
      id: `a-${i}`,
      teamId: TEAM_ID,
      epochId: EPOCH_ID,
      kind: 'message',
      actorAppId: LEAD_APP,
      targetAppId: RESEARCHER_APP,
      subject: `instruction ${i}`,
      body: `the full text of instruction ${i}`,
      refId: null,
      correlationId: `c-${i}`,
      status: 'sent',
      createdAt: 1_700_000_000_000 + i,
    })
  }
}

describe('exported team record', () => {
  let dbManager: DatabaseManager
  let store: TeamStore
  let dir: string
  /** A second instance's database, only where a test needs one. */
  let siblingDbManager: DatabaseManager | null

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    seed(store)
    siblingDbManager = null
    dir = mkdtempSync(join(tmpdir(), 'halo-board-archive-test-'))
  })

  afterEach(() => {
    dbManager.closeAll()
    siblingDbManager?.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes nothing when the reader already showed everything', () => {
    addActs(store, 5)
    const archive = createBoardArchive({ store, dir })

    expect(archive.materialize(TEAM_ID, EPOCH_ID, 5)).toBeNull()
    expect(existsSync(dir) ? readdirSync(dir) : []).toHaveLength(0)
  })

  it('exports every act, not just the withheld tail', () => {
    addActs(store, 120)
    const archive = createBoardArchive({ store, dir })

    const result = archive.materialize(TEAM_ID, EPOCH_ID, 99)

    expect(result?.total).toBe(120)
    expect(result?.path).toBeTruthy()
    const content = readFileSync(result!.path!, 'utf-8')
    // The oldest act is the one the window dropped first; the newest proves the
    // export is not a stale prefix.
    expect(content).toContain('instruction 0')
    expect(content).toContain('instruction 119')
    expect(content).toContain('120 entries')
  })

  it('resolves member names and keeps message bodies out', () => {
    addActs(store, 120)
    const archive = createBoardArchive({ store, dir })

    const content = readFileSync(archive.materialize(TEAM_ID, EPOCH_ID, 99)!.path!, 'utf-8')

    expect(content).toContain('researcher')
    expect(content).not.toContain(RESEARCHER_APP)
    // Reach, not exposure: the snapshot withholds message bodies, and moving an
    // act into a file must not quietly widen what an agent can read.
    expect(content).not.toContain('the full text of instruction')
  })

  it('does not rewrite the file while the record has not moved', () => {
    addActs(store, 120)
    const archive = createBoardArchive({ store, dir })

    const first = archive.materialize(TEAM_ID, EPOCH_ID, 99)!
    const writtenAt = statSync(first.path!).mtimeMs
    // Backdate so an unnecessary rewrite would be unmistakable.
    const past = new Date(Date.now() - 60_000)
    utimesSync(first.path!, past, past)

    const second = archive.materialize(TEAM_ID, EPOCH_ID, 99)!

    expect(second.path).toBe(first.path)
    expect(statSync(second.path!).mtimeMs).toBeLessThan(writtenAt)
  })

  it('rebuilds whole when acts arrive, including ones that sort before the last export', () => {
    addActs(store, 120)
    const archive = createBoardArchive({ store, dir })
    const first = archive.materialize(TEAM_ID, EPOCH_ID, 99)!

    // A late arrival from another machine carries its ORIGINAL time, so it lands
    // in the middle of the record. An append would have missed it entirely.
    store.insertActivity({
      id: 'a-late', teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'finding',
      actorAppId: RESEARCHER_APP, targetAppId: null, subject: 'late-arrival.md',
      body: null, refId: null, correlationId: null, status: null,
      createdAt: 1_700_000_000_000 + 5,
    })

    const second = archive.materialize(TEAM_ID, EPOCH_ID, 99)!
    const content = readFileSync(second.path!, 'utf-8')

    expect(second.total).toBe(121)
    expect(second.path).toBe(first.path)
    expect(content).toContain('late-arrival.md')
    // Rebuilt in record order, so the late act sits where its timestamp puts it.
    expect(content.indexOf('late-arrival.md')).toBeLessThan(content.indexOf('instruction 119'))
  })

  it('rebuilds after the file is deleted underneath it', () => {
    addActs(store, 120)
    const archive = createBoardArchive({ store, dir })
    const first = archive.materialize(TEAM_ID, EPOCH_ID, 99)!
    rmSync(first.path!, { force: true })

    const second = archive.materialize(TEAM_ID, EPOCH_ID, 99)!

    expect(second.path).toBe(first.path)
    expect(existsSync(second.path!)).toBe(true)
  })

  it('does not overwrite the printout of another instance on the same machine', () => {
    // Two Halo instances on one machine, each with its own replica of the SAME
    // piece of work and the second a few acts behind. They share the scratch
    // directory, so a name built from the work alone would put both here.
    addActs(store, 120)
    siblingDbManager = createDatabaseManager(':memory:')
    const siblingDb = siblingDbManager.getAppDatabase()
    siblingDbManager.runMigrations(siblingDb, MIGRATION_NAMESPACE, migrations)
    const siblingStore = new TeamStore(siblingDb)
    seed(siblingStore)
    addActs(siblingStore, 105)

    const archive = createBoardArchive({ store, dir, instanceId: 'node-a' })
    const sibling = createBoardArchive({ store: siblingStore, dir, instanceId: 'node-b' })

    const ours = archive.materialize(TEAM_ID, EPOCH_ID, 99)!
    const theirs = sibling.materialize(TEAM_ID, EPOCH_ID, 99)!

    expect(theirs.path).not.toBe(ours.path)
    // Each file still holds what its own reader was told it holds. The count is
    // all a later read checks before handing the path over again, so a file
    // swapped underneath would go unnoticed by everything else here.
    expect(readFileSync(ours.path!, 'utf-8')).toContain('120 entries')
    expect(readFileSync(theirs.path!, 'utf-8')).toContain('105 entries')
    expect(archive.materialize(TEAM_ID, EPOCH_ID, 99)!.path).toBe(ours.path)
  })

  it('never leaves a half-written file where the reader is looking', () => {
    addActs(store, 120)
    const archive = createBoardArchive({ store, dir, instanceId: 'node-a' })
    const first = archive.materialize(TEAM_ID, EPOCH_ID, 99)!

    // The reader is a separate process and can open the printout at any moment,
    // including during a rewrite — so it is renamed into place, never truncated
    // and refilled, and no partial copy is left lying beside it.
    expect(readdirSync(dir)).toEqual([basename(first.path!)])

    addActs(store, 5, 120)
    archive.materialize(TEAM_ID, EPOCH_ID, 99)

    expect(readdirSync(dir)).toEqual([basename(first.path!)])
  })

  it('drops the printout when the piece of work ends', () => {
    addActs(store, 120)
    const archive = createBoardArchive({ store, dir })
    const path = archive.materialize(TEAM_ID, EPOCH_ID, 99)!.path!

    archive.clearEpoch(EPOCH_ID)

    expect(existsSync(path)).toBe(false)
  })

  it('sweeps leftovers from earlier runs and leaves a sibling node’s fresh file alone', () => {
    mkdirSync(dir, { recursive: true })
    const stale = join(dir, 'stale-run.md')
    const fresh = join(dir, 'another-node.md')
    writeFileSync(stale, 'old', 'utf-8')
    writeFileSync(fresh, 'live', 'utf-8')
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(stale, longAgo, longAgo)

    createBoardArchive({ store, dir }).sweep()

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
})
