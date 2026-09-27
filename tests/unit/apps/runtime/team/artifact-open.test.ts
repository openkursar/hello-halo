/**
 * Unit tests for the person-facing opener in runtime/team/artifact-read — what
 * runs when someone clicks a shared file on the team board.
 *
 * Proven:
 *   - a same-machine producer's file is opened in place, never copied;
 *   - a ref two members published is refused, not picked;
 *   - a teammate's file is fetched and written here as a read-only copy;
 *   - without a remote fetch, and when the owner is offline, the failure is
 *     reported as a code the renderer can phrase — not a fake not-found;
 *   - the same ref in two runs lands in two directories, so one run's copy is
 *     never shown for another;
 *   - opening again replaces the previous read-only copy with fresh bytes;
 *   - a teammate's file the OS would execute is flagged reveal-only;
 *   - an oversized teammate file is refused before anything is written;
 *   - pruning removes stale copy directories and keeps recent ones.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync, existsSync, utimesSync, mkdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/team/migrations'
import {
  createLocalArtifactPathResolver,
  createTeamArtifactOpener,
  pruneSharedFileCopies,
  MAX_OPEN_COPY_BYTES,
  RemoteArtifactError,
} from '../../../../../src/main/apps/runtime/team/artifact-read'

const TEAM_ID = 'team-1'
const EPOCH_A = 'epoch-a'
const EPOCH_B = 'epoch-b'
const LOCAL_APP = 'app-local'
const REMOTE_APP = 'app-remote'

type FetchRemote = NonNullable<Parameters<typeof createTeamArtifactOpener>[0]['fetchRemote']>

describe('team artifact opener', () => {
  let dbManager: DatabaseManager
  let store: TeamStore
  let workDir: string
  let copyDir: string

  function publish(ref: string, authorAppId: string, epochId = EPOCH_A): void {
    store.insertFinding({
      id: `finding-${authorAppId}-${epochId}-${ref}`,
      teamId: TEAM_ID,
      epochId,
      authorAppId,
      body: null,
      ref,
      createdAt: Date.now(),
    })
  }

  function makeOpener(fetchRemote?: FetchRemote) {
    return createTeamArtifactOpener({
      store,
      resolveLocalPath: createLocalArtifactPathResolver({
        store,
        getWorkDirForApp: (appId) => (appId === LOCAL_APP ? workDir : null),
      }),
      copyDir,
      ...(fetchRemote ? { fetchRemote } : {}),
    })
  }

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    const now = Date.now()
    store.insertTeam({
      id: TEAM_ID, name: 'Team', owningSpaceId: 'space-a', goal: 'g', leadAppId: LOCAL_APP,
      memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user', status: 'running',
      currentEpochId: EPOCH_A, createdAt: now, updatedAt: now,
    })
    store.addMember({
      teamId: TEAM_ID, appId: LOCAL_APP, memberName: 'local', role: 'Writer',
      isLead: true, aiProvisioned: false, addedAt: now,
    })
    store.addMember({
      teamId: TEAM_ID, appId: REMOTE_APP, memberName: 'remote', role: 'Analyst',
      isLead: false, aiProvisioned: false, addedAt: now,
      origin: 'remote', ownerNodeId: 'node-remote', ownerDisplayName: 'Alice',
    })
    for (const id of [EPOCH_A, EPOCH_B]) {
      store.insertEpoch({ id, teamId: TEAM_ID, startedAt: now, endedAt: null, endReason: null, summary: null, lifecycle: 'run' })
    }
    workDir = mkdtempSync(join(tmpdir(), 'halo-open-work-'))
    copyDir = mkdtempSync(join(tmpdir(), 'halo-open-copies-'))
  })

  afterEach(() => {
    dbManager.closeAll()
    rmSync(workDir, { recursive: true, force: true })
    // Copies are written read-only; lift that so the temp dir can be removed.
    rmSync(copyDir, { recursive: true, force: true })
  })

  it('opens a same-machine file in place', async () => {
    writeFileSync(join(workDir, 'brief.md'), 'local')
    publish('brief.md', LOCAL_APP)

    const res = await makeOpener()({ teamId: TEAM_ID, epochId: EPOCH_A, ref: 'brief.md' })
    expect(res).toMatchObject({ ok: true, copied: false, owner: null })
    expect(res.path).toBe(realpathSync(join(workDir, 'brief.md')))
  })

  it('refuses a ref two members published', async () => {
    publish('report.md', LOCAL_APP)
    publish('report.md', REMOTE_APP)
    const res = await makeOpener()({ teamId: TEAM_ID, epochId: EPOCH_A, ref: 'report.md' })
    expect(res).toMatchObject({ ok: false, reason: 'ambiguous' })
  })

  it('writes a teammate file here as a read-only copy', async () => {
    publish('notes.md', REMOTE_APP)
    const res = await makeOpener(async () => new TextEncoder().encode('from alice'))({
      teamId: TEAM_ID, epochId: EPOCH_A, ref: 'notes.md',
    })
    expect(res).toMatchObject({ ok: true, copied: true, owner: 'Alice', revealOnly: false })
    expect(res.path!.startsWith(copyDir)).toBe(true)
    expect(readFileSync(res.path!, 'utf8')).toBe('from alice')
    expect(statSync(res.path!).mode & 0o222).toBe(0)
  })

  it('reports unavailable when cross-machine fetch is not wired', async () => {
    publish('notes.md', REMOTE_APP)
    const res = await makeOpener()({ teamId: TEAM_ID, epochId: EPOCH_A, ref: 'notes.md' })
    expect(res).toMatchObject({ ok: false, reason: 'unavailable', owner: 'Alice' })
  })

  it('reports an offline owner as unreachable', async () => {
    publish('notes.md', REMOTE_APP)
    const res = await makeOpener(async () => {
      throw new RemoteArtifactError('owner-unreachable', 'OWNER_OFFLINE')
    })({ teamId: TEAM_ID, epochId: EPOCH_A, ref: 'notes.md' })
    expect(res).toMatchObject({ ok: false, reason: 'unreachable', owner: 'Alice' })
  })

  it('keeps the same ref from two runs in separate directories', async () => {
    publish('out.md', REMOTE_APP, EPOCH_A)
    publish('out.md', REMOTE_APP, EPOCH_B)
    const open = makeOpener(async ({ epochId }) => new TextEncoder().encode(epochId))
    const a = await open({ teamId: TEAM_ID, epochId: EPOCH_A, ref: 'out.md' })
    const b = await open({ teamId: TEAM_ID, epochId: EPOCH_B, ref: 'out.md' })
    expect(a.path).not.toBe(b.path)
    expect(readFileSync(a.path!, 'utf8')).toBe(EPOCH_A)
    expect(readFileSync(b.path!, 'utf8')).toBe(EPOCH_B)
  })

  it('replaces the previous read-only copy when opened again', async () => {
    publish('notes.md', REMOTE_APP)
    let version = 'first'
    const open = makeOpener(async () => new TextEncoder().encode(version))
    const first = await open({ teamId: TEAM_ID, epochId: EPOCH_A, ref: 'notes.md' })
    version = 'second'
    const second = await open({ teamId: TEAM_ID, epochId: EPOCH_A, ref: 'notes.md' })
    expect(second.ok).toBe(true)
    expect(second.path).toBe(first.path)
    expect(readFileSync(second.path!, 'utf8')).toBe('second')
  })

  it('flags a teammate file the OS would run as reveal-only', async () => {
    publish('setup.exe', REMOTE_APP)
    publish('run.BAT', REMOTE_APP)
    const open = makeOpener(async () => new Uint8Array([1, 2, 3]))
    expect((await open({ teamId: TEAM_ID, epochId: EPOCH_A, ref: 'setup.exe' })).revealOnly).toBe(true)
    expect((await open({ teamId: TEAM_ID, epochId: EPOCH_A, ref: 'run.BAT' })).revealOnly).toBe(true)
  })

  it('refuses an oversized teammate file before writing it', async () => {
    publish('huge.bin', REMOTE_APP)
    const huge = { length: MAX_OPEN_COPY_BYTES + 1 } as Uint8Array
    const res = await makeOpener(async () => huge)({ teamId: TEAM_ID, epochId: EPOCH_A, ref: 'huge.bin' })
    expect(res).toMatchObject({ ok: false, reason: 'too-large' })
  })

  it('prunes stale copy directories and keeps recent ones', async () => {
    const stale = join(copyDir, 'stale')
    const fresh = join(copyDir, 'fresh')
    mkdirSync(stale)
    mkdirSync(fresh)
    writeFileSync(join(stale, 'a.md'), 'x', { mode: 0o444 })
    const now = Date.now()
    const old = (now - 10 * 24 * 3600 * 1000) / 1000
    utimesSync(stale, old, old)

    await pruneSharedFileCopies(copyDir, 7 * 24 * 3600 * 1000, now)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
})
