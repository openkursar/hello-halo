/**
 * Unit tests for the publish gate in the team tools: what happens when a member
 * publishes a file reference.
 *
 * This is the seam where a wrong ref used to be accepted silently and only fail
 * hours later on a teammate's machine, so the assertions are about the board as
 * much as the reply — a refusal must leave NOTHING behind.
 *
 * Proven:
 *   - a valid ref is published and the receipt names the ref teammates will use;
 *   - an absolute path inside the work dir is stored in its portable relative
 *     form, so it still resolves on another machine;
 *   - a file outside the work dir, and a missing file, are refused — and no
 *     finding row is written;
 *   - a name another member already published is refused: two rows carrying one
 *     name are indistinguishable to every later reader, and this is the last
 *     moment anyone can still tell them apart;
 *   - republishing your OWN name is an update, not a collision, and a lead may
 *     attach a member's file to that member's task without tripping the gate;
 *   - a refused resultRef leaves the task status untouched too (no half-applied
 *     update that shows work as delivered without its deliverable);
 *   - a finding with content and no ref is unaffected by the gate.
 *
 * The SDK's tool() wrapper is mocked to expose the handler directly; the
 * blackboard, store and filesystem underneath are real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
  }),
  createSdkMcpServer: (options: { tools: Array<{ name: string }> }) => options,
}))

import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/team/migrations'
import { createBlackboard } from '../../../../../src/main/apps/runtime/team/blackboard'
import { createTeamMcpServer } from '../../../../../src/main/apps/runtime/team/team-tools'
import type { TeamMcpContext } from '../../../../../src/main/apps/runtime/team/team-tools'
import type { MessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import type { Team, TeamEpoch } from '../../../../../src/main/apps/team/types'
import { TEAM_TOOL_NAMES } from '../../../../../src/shared/apps/team-types'

const TEAM_ID = 'team-1'
const EPOCH_ID = 'epoch-1'
const APP_ID = 'app-writer'
const PEER_APP_ID = 'app-analyst'

type ToolReply = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

describe('team tools publish gate', () => {
  let dbManager: DatabaseManager
  let store: TeamStore
  let workDir: string
  let outside: string
  let call: (toolName: string, input: Record<string, unknown>) => Promise<ToolReply>

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)

    const now = Date.now()
    const team: Team = {
      id: TEAM_ID,
      name: 'Team',
      owningSpaceId: 'space-a',
      goal: 'g',
      leadAppId: APP_ID,
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
      appId: APP_ID,
      memberName: 'writer',
      role: 'Writer',
      isLead: true,
      aiProvisioned: false,
      addedAt: now,
    })
    store.addMember({
      teamId: TEAM_ID,
      appId: PEER_APP_ID,
      memberName: 'analyst',
      role: 'Analyst',
      isLead: false,
      aiProvisioned: false,
      addedAt: now,
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

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'halo-publish-gate-')))
    workDir = join(root, 'project')
    outside = join(root, 'elsewhere')
    mkdirSync(workDir)
    mkdirSync(outside)

    const ctx: TeamMcpContext = {
      teamId: TEAM_ID,
      epochId: EPOCH_ID,
      callerAppId: APP_ID,
      collabMode: 'free',
      selfIsLead: true,
      bus: {} as MessageBus,
      blackboard: createBlackboard({ store }),
      callerWorkDir: workDir,
      requestComplete: () => {},
    }
    const server = createTeamMcpServer(ctx) as unknown as {
      tools: Array<{ name: string; handler: (input: Record<string, unknown>) => Promise<ToolReply> }>
    }
    call = async (toolName, input) => {
      const found = server.tools.find((t) => t.name === toolName)
      if (!found) throw new Error(`tool not registered: ${toolName}`)
      return found.handler(input)
    }
  })

  afterEach(() => {
    dbManager.closeAll()
    rmSync(workDir, { recursive: true, force: true })
  })

  const findings = () => store.listFindingsByEpoch(TEAM_ID, EPOCH_ID)

  function seedTask(assigneeAppId: string | null = APP_ID, taskId = 'task-1'): string {
    const now = Date.now()
    store.insertTask({
      id: taskId,
      teamId: TEAM_ID,
      epochId: EPOCH_ID,
      title: 'Write the design',
      assigneeAppId,
      status: 'in_progress',
      resultRef: null,
      note: null,
      parentId: null,
      createdByAppId: APP_ID,
      createdAt: now,
      updatedAt: now,
    })
    return taskId
  }

  /** A ref another member already put on the board. */
  function peerPublished(ref: string): void {
    store.insertFinding({
      id: `finding-peer-${ref}`,
      teamId: TEAM_ID,
      epochId: EPOCH_ID,
      authorAppId: PEER_APP_ID,
      body: null,
      ref,
      createdAt: Date.now(),
    })
  }

  describe('team_post_finding', () => {
    it('publishes an existing file and names the ref teammates will use', async () => {
      mkdirSync(join(workDir, 'docs'))
      writeFileSync(join(workDir, 'docs', 'design.md'), 'hello')

      const res = await call(TEAM_TOOL_NAMES.postFinding, { ref: 'docs/design.md' })
      expect(res.isError).toBeUndefined()
      expect(res.content[0].text).toContain('docs/design.md')
      expect(res.content[0].text).toContain(TEAM_TOOL_NAMES.readArtifact)
      expect(findings()[0]?.ref).toBe('docs/design.md')
    })

    it('stores an absolute path in its portable relative form', async () => {
      writeFileSync(join(workDir, 'notes.md'), 'hello')

      const res = await call(TEAM_TOOL_NAMES.postFinding, { ref: join(workDir, 'notes.md') })
      expect(res.isError).toBeUndefined()
      // What lands on the board must mean the same thing on a teammate's machine.
      expect(findings()[0]?.ref).toBe('notes.md')
    })

    it('refuses a file outside the work dir and writes nothing', async () => {
      writeFileSync(join(outside, 'secret.md'), 'hello')

      const res = await call(TEAM_TOOL_NAMES.postFinding, { ref: join(outside, 'secret.md') })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toContain('Nothing was published')
      expect(res.content[0].text).toContain(workDir)
      expect(findings()).toHaveLength(0)
    })

    it('refuses a ref whose file does not exist and writes nothing', async () => {
      const res = await call(TEAM_TOOL_NAMES.postFinding, { ref: 'docs/design.md' })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toContain('does not exist')
      expect(findings()).toHaveLength(0)
    })

    it('refuses a name another member already published and writes nothing', async () => {
      writeFileSync(join(workDir, 'report.md'), 'mine')
      peerPublished('report.md')

      const res = await call(TEAM_TOOL_NAMES.postFinding, { ref: 'report.md' })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toContain('Nothing was published')
      // A rename is the only move available to this agent, so the refusal has to
      // name the holder and offer it.
      expect(res.content[0].text).toContain('analyst')
      expect(res.content[0].text).toContain('Rename')
      expect(findings()).toHaveLength(1) // only the peer's row
    })

    it('collides on the STORED form, so an absolute path cannot slip past', async () => {
      writeFileSync(join(workDir, 'report.md'), 'mine')
      peerPublished('report.md')

      const res = await call(TEAM_TOOL_NAMES.postFinding, { ref: join(workDir, 'report.md') })
      expect(res.isError).toBe(true)
      expect(findings()).toHaveLength(1)
    })

    it('lets a member republish its own ref (an update, not a collision)', async () => {
      writeFileSync(join(workDir, 'notes.md'), 'v1')

      expect((await call(TEAM_TOOL_NAMES.postFinding, { ref: 'notes.md' })).isError).toBeUndefined()
      const second = await call(TEAM_TOOL_NAMES.postFinding, { ref: 'notes.md', content: 'v2 is up' })
      expect(second.isError).toBeUndefined()
      expect(findings()).toHaveLength(2)
    })

    it('leaves a content-only finding untouched', async () => {
      const res = await call(TEAM_TOOL_NAMES.postFinding, { content: 'competitor dropped prices' })
      expect(res.isError).toBeUndefined()
      expect(findings()[0]?.body).toBe('competitor dropped prices')
      expect(findings()[0]?.ref).toBeNull()
    })
  })

  describe('team_update_task', () => {
    it('attaches a valid resultRef in relative form', async () => {
      const taskId = seedTask()
      writeFileSync(join(workDir, 'design.md'), 'hello')

      const res = await call(TEAM_TOOL_NAMES.updateTask, {
        taskId,
        status: 'done',
        resultRef: join(workDir, 'design.md'),
      })
      expect(res.isError).toBeUndefined()
      const task = store.getTaskById(taskId)
      expect(task?.status).toBe('done')
      expect(task?.resultRef).toBe('design.md')
    })

    it('refuses the whole update when the resultRef is unusable', async () => {
      const taskId = seedTask()

      const res = await call(TEAM_TOOL_NAMES.updateTask, {
        taskId,
        status: 'done',
        resultRef: 'docs/design.md',
      })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toContain('was NOT updated')
      // A task shown done with its deliverable silently dropped is the same
      // false success the gate exists to end.
      const task = store.getTaskById(taskId)
      expect(task?.status).toBe('in_progress')
      expect(task?.resultRef).toBeNull()
    })

    it('refuses a resultRef another member already published, leaving the task untouched', async () => {
      const taskId = seedTask()
      writeFileSync(join(workDir, 'design.md'), 'mine')
      peerPublished('design.md')

      const res = await call(TEAM_TOOL_NAMES.updateTask, {
        taskId,
        status: 'done',
        resultRef: 'design.md',
      })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toContain('was NOT updated')
      expect(res.content[0].text).toContain('analyst')
      const task = store.getTaskById(taskId)
      expect(task?.status).toBe('in_progress')
      expect(task?.resultRef).toBeNull()
    })

    it('attaches a member\u2019s own published file to that member\u2019s task', async () => {
      // The caller is the lead, but the ref belongs to the ASSIGNEE who published
      // it: keying the check on the caller would refuse a ref that still resolves
      // to exactly one producer.
      const taskId = seedTask(PEER_APP_ID, 'task-peer')
      writeFileSync(join(workDir, 'design.md'), 'the analyst\u2019s file')
      peerPublished('design.md')

      const res = await call(TEAM_TOOL_NAMES.updateTask, {
        taskId,
        status: 'done',
        resultRef: 'design.md',
      })
      expect(res.isError).toBeUndefined()
      expect(store.getTaskById(taskId)?.resultRef).toBe('design.md')
    })

    it('updates status normally when no resultRef is given', async () => {
      const taskId = seedTask()

      const res = await call(TEAM_TOOL_NAMES.updateTask, { taskId, status: 'blocked', note: 'waiting' })
      expect(res.isError).toBeUndefined()
      expect(store.getTaskById(taskId)?.status).toBe('blocked')
    })
  })
})
