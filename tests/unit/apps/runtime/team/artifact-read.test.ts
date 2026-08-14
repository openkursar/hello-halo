/**
 * Unit tests for runtime/team artifact-read — the location-transparent logic
 * behind `team_read_artifact`, against a real in-memory TeamStore.
 *
 * Proven:
 *   - a finding-published ref of a local producer resolves to its text, and names
 *     the producer so the reader can see whose file the name opened;
 *   - a resultRef-only delivery (task done, no finding) resolves the same way —
 *     both publication forms the tools promise are actually readable;
 *   - one member publishing a ref twice, in both forms, is still one producer;
 *   - a ref two members published is refused as ambiguous and names them, rather
 *     than silently handing back whichever row sorted first;
 *   - an unpublished ref returns not-found with publish guidance;
 *   - a published-but-vanished file is reported as moved, NOT as "re-publish it"
 *     (publication is validated when it happens, so that advice only loops);
 *   - the local resolver refuses traversal and out-of-work-dir absolute refs,
 *     while still serving a legacy absolute ref that lands inside the work dir;
 *   - a binary artifact (NUL in head) is refused, never inlined;
 *   - oversized text is truncated at a UTF-8 character boundary (no U+FFFD);
 *   - a remote producer without an injected remote fetch reports the capability
 *     unavailable (honest degradation, not a fake not-found);
 *   - remote failures map to calm guidance per classified failure — raw
 *     transport codes never reach the agent-facing message;
 *   - a remote fetch success decodes exactly like a local read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/team/migrations'
import type { Team, TeamEpoch } from '../../../../../src/main/apps/team/types'
import {
  createLocalArtifactResolver,
  createTeamArtifactReader,
  RemoteArtifactError,
} from '../../../../../src/main/apps/runtime/team/artifact-read'

const TEAM_ID = 'team-1'
const EPOCH_ID = 'epoch-1'
const LOCAL_APP = 'app-local'
const REMOTE_APP = 'app-remote'
const REMOTE_NODE = 'node-remote'

describe('artifact-read', () => {
  let dbManager: DatabaseManager
  let store: TeamStore
  let workDir: string

  function seed(): void {
    const now = Date.now()
    const team: Team = {
      id: TEAM_ID,
      name: 'Team',
      owningSpaceId: 'space-a',
      goal: 'g',
      leadAppId: LOCAL_APP,
      memberSourcing: 'manual',
      collabMode: 'free',
      escalationRouting: 'user',
      status: 'running',
      currentEpochId: EPOCH_ID,
      createdAt: now,
      updatedAt: now,
    }
    store.insertTeam(team)
    store.addMember({
      teamId: TEAM_ID,
      appId: LOCAL_APP,
      memberName: 'local',
      role: 'Writer',
      isLead: true,
      aiProvisioned: false,
      addedAt: now,
    })
    store.addMember({
      teamId: TEAM_ID,
      appId: REMOTE_APP,
      memberName: 'remote',
      role: 'Analyst',
      isLead: false,
      aiProvisioned: false,
      addedAt: now,
      origin: 'remote',
      ownerNodeId: REMOTE_NODE,
      ownerDisplayName: 'Alice',
    })
    const epoch: TeamEpoch = {
      id: EPOCH_ID,
      teamId: TEAM_ID,
      startedAt: now,
      endedAt: null,
      endReason: null,
      summary: null,
      lifecycle: 'run',
    }
    store.insertEpoch(epoch)
  }

  function publishFinding(ref: string, authorAppId = LOCAL_APP): void {
    store.insertFinding({
      id: `finding-${authorAppId}-${ref}`,
      teamId: TEAM_ID,
      epochId: EPOCH_ID,
      authorAppId,
      body: null,
      ref,
      createdAt: Date.now(),
    })
  }

  function deliverAsResultRef(ref: string, assigneeAppId = LOCAL_APP): void {
    const now = Date.now()
    store.insertTask({
      id: `task-${ref}`,
      teamId: TEAM_ID,
      epochId: EPOCH_ID,
      title: `Produce ${ref}`,
      assigneeAppId,
      status: 'done',
      resultRef: ref,
      note: null,
      parentId: null,
      createdByAppId: LOCAL_APP,
      createdAt: now,
      updatedAt: now,
    })
  }

  function makeReader(overrides?: Partial<Parameters<typeof createTeamArtifactReader>[0]>) {
    const readLocalBytes = createLocalArtifactResolver({
      store,
      getWorkDirForApp: (appId) => (appId === LOCAL_APP ? workDir : null),
    })
    return createTeamArtifactReader({ store, readLocalBytes, ...overrides })
  }

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    seed()
    workDir = mkdtempSync(join(tmpdir(), 'halo-artifact-read-'))
  })

  afterEach(() => {
    dbManager.closeAll()
    rmSync(workDir, { recursive: true, force: true })
  })

  describe('local producer', () => {
    it('reads a finding-published ref', async () => {
      writeFileSync(join(workDir, 'brief.md'), '# Brief\ncontent')
      publishFinding('brief.md')

      const res = await makeReader()({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: 'brief.md' })
      expect(res.ok).toBe(true)
      expect(res.content).toBe('# Brief\ncontent')
      expect(res.owner).toBeNull()
      // Named even for a same-machine producer: a ref alone never says whose
      // file the reader is about to trust.
      expect(res.producer).toBe('local')
      expect(res.truncated).toBe(false)
    })

    it('treats one member publishing a ref in both forms as one producer', async () => {
      writeFileSync(join(workDir, 'plan.md'), 'one author, two rows')
      publishFinding('plan.md')
      deliverAsResultRef('plan.md')

      const res = await makeReader()({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: 'plan.md' })
      expect(res.ok).toBe(true)
      expect(res.content).toBe('one author, two rows')
    })

    it('refuses a ref two members published instead of picking one', async () => {
      writeFileSync(join(workDir, 'report.md'), 'the local one')
      publishFinding('report.md', LOCAL_APP)
      publishFinding('report.md', REMOTE_APP)

      const res = await makeReader()({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: 'report.md' })
      expect(res.ok).toBe(false)
      expect(res.reason).toBe('ambiguous')
      expect(res.message).toContain('local')
      expect(res.message).toContain('remote')
      // Neither candidate's bytes are served alongside the refusal.
      expect(res.content).toBeUndefined()
    })

    it('reads a resultRef-only delivery (task done, no finding)', async () => {
      writeFileSync(join(workDir, 'report.md'), 'delivered via resultRef')
      deliverAsResultRef('report.md')

      const res = await makeReader()({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: 'report.md' })
      expect(res.ok).toBe(true)
      expect(res.content).toBe('delivered via resultRef')
    })

    it('returns not-found with publish guidance for an unpublished ref', async () => {
      writeFileSync(join(workDir, 'exists.md'), 'on disk but never published')

      const res = await makeReader()({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: 'exists.md' })
      expect(res.ok).toBe(false)
      expect(res.reason).toBe('not-found')
      expect(res.message).toContain('team_post_finding')
      expect(res.message).toContain('resultRef')
    })

    it('says the file moved (not "re-publish") when it is gone from disk', async () => {
      publishFinding('gone.md')

      const res = await makeReader()({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: 'gone.md' })
      expect(res.ok).toBe(false)
      expect(res.reason).toBe('not-found')
      expect(res.message).toContain('moved or deleted')
      // Publication is validated when it happens, so re-publishing the same
      // vanished path only loops — the guidance must not send them there.
      expect(res.message).not.toContain('re-publish')
    })

    it('reads a ref nested under the work dir', async () => {
      mkdirSync(join(workDir, 'docs'), { recursive: true })
      writeFileSync(join(workDir, 'docs', 'design.md'), '# Design')
      publishFinding('docs/design.md')

      const res = await makeReader()({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: 'docs/design.md' })
      expect(res.ok).toBe(true)
      expect(res.content).toBe('# Design')
    })

    it('refuses traversal and out-of-work-dir absolute refs even when published', async () => {
      writeFileSync(join(workDir, 'secret.txt'), 'secret')
      publishFinding('../secret.txt')
      publishFinding('/etc/hosts')

      const reader = makeReader()
      const traversal = await reader({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: '../secret.txt' })
      expect(traversal.ok).toBe(false)
      expect(traversal.reason).toBe('not-found')
      const absolute = await reader({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: '/etc/hosts' })
      expect(absolute.ok).toBe(false)
    })

    it('still serves a legacy absolute ref that points inside the work dir', async () => {
      // Rows written before refs were normalized at publish time.
      const abs = join(workDir, 'legacy.md')
      writeFileSync(abs, 'stored absolute')
      publishFinding(abs)

      const res = await makeReader()({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: abs })
      expect(res.ok).toBe(true)
      expect(res.content).toBe('stored absolute')
    })

    it('refuses a binary artifact instead of inlining it', async () => {
      writeFileSync(join(workDir, 'blob.bin'), Buffer.from([1, 2, 0, 3, 4]))
      publishFinding('blob.bin')

      const res = await makeReader()({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: 'blob.bin' })
      expect(res.ok).toBe(false)
      expect(res.reason).toBe('binary')
      expect(res.bytes).toBe(5)
    })

    it('truncates oversized text at a UTF-8 character boundary', async () => {
      // "é" is 2 bytes (0xC3 0xA9); a 15-byte cap over "aaaaaaaaaaaaaaé..." would
      // split the glyph without boundary handling.
      const text = 'aaaaaaaaaaaaaa' + 'é'.repeat(20) // 14 + 40 bytes
      writeFileSync(join(workDir, 'big.md'), text)
      publishFinding('big.md')

      const res = await makeReader({ inlineCapBytes: 15 })({
        teamId: TEAM_ID,
        epochId: EPOCH_ID,
        ref: 'big.md',
      })
      expect(res.ok).toBe(true)
      expect(res.truncated).toBe(true)
      expect(res.content).toBe('aaaaaaaaaaaaaa') // the split "é" is dropped whole
      expect(res.content).not.toContain('\uFFFD')
      expect(res.bytes).toBe(Buffer.byteLength(text))
    })
  })

  describe('remote producer', () => {
    it('reports the capability unavailable when no remote fetch is injected', async () => {
      publishFinding('remote.md', REMOTE_APP)

      const res = await makeReader()({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: 'remote.md' })
      expect(res.ok).toBe(false)
      expect(res.reason).toBe('unavailable')
      expect(res.owner).toBe('Alice')
      expect(res.message).toContain('Alice')
    })

    it('fetches a remote resultRef-only delivery from the owner', async () => {
      deliverAsResultRef('analysis.md', REMOTE_APP)

      const res = await makeReader({
        fetchRemote: async (params) => {
          expect(params.ownerNodeId).toBe(REMOTE_NODE)
          expect(params.ref).toBe('analysis.md')
          return new TextEncoder().encode('remote bytes')
        },
      })({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: 'analysis.md' })

      expect(res.ok).toBe(true)
      expect(res.content).toBe('remote bytes')
      expect(res.owner).toBe('Alice')
      expect(res.producer).toBe('remote')
    })

    it.each([
      ['owner-unreachable', 'unreachable', 'can\u2019t be reached'],
      ['not-published', 'not-found', 'team_post_finding'],
      ['not-found', 'not-found', 'moved or deleted'],
    ] as const)('maps a %s remote failure to calm guidance', async (failure, reason, phrase) => {
      publishFinding('remote.md', REMOTE_APP)

      const res = await makeReader({
        fetchRemote: async () => {
          throw new RemoteArtifactError(failure, `artifact-${failure}`)
        },
      })({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: 'remote.md' })

      expect(res.ok).toBe(false)
      expect(res.reason).toBe(reason)
      expect(res.message).toContain(phrase)
      // Never a raw transport code in the agent-facing message.
      expect(res.message).not.toContain(`artifact-${failure}`)
    })

    it('maps an unclassified transport error to a generic calm message', async () => {
      publishFinding('remote.md', REMOTE_APP)

      const res = await makeReader({
        fetchRemote: async () => {
          throw new Error('socket hang up (ECONNRESET)')
        },
      })({ teamId: TEAM_ID, epochId: EPOCH_ID, ref: 'remote.md' })

      expect(res.ok).toBe(false)
      expect(res.reason).toBe('error')
      expect(res.message).not.toContain('ECONNRESET')
    })
  })
})
