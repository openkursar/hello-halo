/**
 * Unit tests for the office record (team_activity) and the board digest.
 *
 * The record exists because tasks/findings only hold current STATE, and directed
 * messages held nothing at all — so these tests pin the two properties that
 * matter: acts are append-only and idempotent, and the digest reports what
 * CHANGED as well as what pointedly has not, without ever turning a missing row
 * into a claim that something did not happen.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { broadcastToAll, sendToRenderer } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
}))
vi.mock('../../../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../../../src/main/foundation/window.service', () => ({ sendToRenderer }))

import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/team/migrations'
import { createBlackboard } from '../../../../../src/main/apps/runtime/team/blackboard'
import { createBoardDigest } from '../../../../../src/main/apps/runtime/team/board-digest'
import { createMessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import type { Team, TeamMember, TeamEpoch } from '../../../../../src/main/apps/team/types'
import type { BlackboardWriteRecord } from '../../../../../src/main/apps/runtime/team/blackboard'
import { buildTeamSessionKey } from '../../../../../src/shared/apps/im-keys'

const TEAM_ID = 'team-1'
const EPOCH_ID = 'epoch-1'
const LEAD_APP = 'app-lead'
const RESEARCHER_APP = 'app-researcher'
/** A third member, so a test can stage traffic the viewer is no part of. */
const WRITER_APP = 'app-writer'

const HOUR = 60 * 60 * 1000

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
  const epoch: TeamEpoch = { id: EPOCH_ID, teamId: TEAM_ID, startedAt: now, endedAt: null, endReason: null, summary: null, lifecycle: 'run' }
  store.insertEpoch(epoch)
}

function addWriter(store: TeamStore): void {
  store.addMember({
    teamId: TEAM_ID, appId: WRITER_APP, memberName: 'writer', role: 'Writing',
    isLead: false, aiProvisioned: false, addedAt: Date.now(),
  })
}

describe('office record + board digest', () => {
  let dbManager: DatabaseManager
  let store: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    seed(store)
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  describe('store', () => {
    it('re-inserting the same act is a no-op, not a throw (replica echo / catch-up replay)', () => {
      const act = {
        id: 'a-1', teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'message' as const,
        actorAppId: LEAD_APP, targetAppId: RESEARCHER_APP, subject: 'go', body: 'go now',
        refId: 'a-1', correlationId: 'c-1', status: 'sent' as const, createdAt: 1,
      }
      store.insertActivity(act)
      expect(() => store.insertActivity(act)).not.toThrow()
      expect(store.listActivityByEpoch(TEAM_ID, EPOCH_ID)).toHaveLength(1)
    })

    it('keeps a reply as its own row, carrying the original correlation id', () => {
      store.insertActivity({
        id: 'a-1', teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'message',
        actorAppId: LEAD_APP, targetAppId: RESEARCHER_APP, subject: 'go', body: null,
        refId: 'a-1', correlationId: 'c-1', status: 'sent', createdAt: 1,
      })
      store.insertActivity({
        id: 'a-2', teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'reply',
        actorAppId: RESEARCHER_APP, targetAppId: LEAD_APP, subject: 'done', body: null,
        refId: null, correlationId: 'c-1', status: 'ok', createdAt: 2,
      })

      // Append-only: the message row is untouched, so replication stays one
      // idempotent insert and a rejected shadow write rolls back to a delete.
      const rows = store.listActivityByEpoch(TEAM_ID, EPOCH_ID)
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.kind === 'message')?.status).toBe('sent')
      expect(rows.find((r) => r.kind === 'reply')?.correlationId).toBe('c-1')
    })
  })

  describe('blackboard', () => {
    it('postActivity emits, persists, and offers the row for replication', () => {
      const writes: BlackboardWriteRecord[] = []
      const board = createBlackboard({ store, onWrite: (r) => writes.push(r) })

      const { activityId } = board.postActivity({
        teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'finding',
        actorAppId: RESEARCHER_APP, subject: 'notes.md', refId: 'f-1',
      })

      expect(store.listActivityByEpoch(TEAM_ID, EPOCH_ID).map((a) => a.id)).toEqual([activityId])
      expect(writes.map((w) => w.op)).toEqual(['post_activity'])
      expect(broadcastToAll).toHaveBeenCalledWith(
        'team:blackboard',
        expect.objectContaining({ kind: 'activity', activity: expect.objectContaining({ id: activityId }) })
      )
    })

    it('the agent-facing snapshot carries subjects but never message bodies', () => {
      const board = createBlackboard({ store })
      board.postActivity({
        teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'message',
        actorAppId: LEAD_APP, targetAppId: RESEARCHER_APP,
        subject: 'confirm the field spec', body: 'confirm the field spec\n\n(long details)',
      })

      const snapshot = board.readBoard(TEAM_ID, EPOCH_ID, RESEARCHER_APP)
      expect(snapshot.activities).toHaveLength(1)
      expect(snapshot.activities[0].subject).toBe('confirm the field spec')
      expect(snapshot.activities[0].body).toBeNull()
      // The full text is still on the row for the UI to open on demand.
      expect(store.listActivityByEpoch(TEAM_ID, EPOCH_ID)[0].body).toContain('long details')
    })
  })

  describe('digest', () => {
    it('says nothing when nothing has happened', () => {
      const digest = createBoardDigest({ store })
      expect(digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: RESEARCHER_APP })).toBeNull()
    })

    it("reports a teammate's act once, then stays quiet", () => {
      const board = createBlackboard({ store })
      const digest = createBoardDigest({ store })
      board.postActivity({
        teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'finding',
        actorAppId: LEAD_APP, subject: 'brief.md',
      })

      const first = digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: RESEARCHER_APP })
      expect(first).toContain('lead')
      expect(first).toContain('brief.md')
      expect(digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: RESEARCHER_APP })).toBeNull()
    })

    it('never reports a member its own acts back to it', () => {
      const board = createBlackboard({ store })
      const digest = createBoardDigest({ store })
      board.postActivity({
        teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'finding',
        actorAppId: RESEARCHER_APP, subject: 'brief.md',
      })
      expect(digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: RESEARCHER_APP })).toBeNull()
    })

    it('draws no conclusion from a task nobody has moved', () => {
      const board = createBlackboard({ store })
      const { taskId } = board.postTask({
        teamId: TEAM_ID, epochId: EPOCH_ID, callerAppId: LEAD_APP,
        title: 'Review the cases', assigneeAppId: RESEARCHER_APP,
      })
      store.updateTask(taskId, { status: 'in_progress' }, Date.now() - HOUR)
      // The act of assigning it is a fact and rides the delta on its own; how long
      // it has sat since is an inference, and the digest does not make it.
      board.postActivity({
        teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'task_post',
        actorAppId: LEAD_APP, targetAppId: RESEARCHER_APP,
        subject: 'Review the cases', refId: taskId,
      })

      const digest = createBoardDigest({ store })
      const text = digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: RESEARCHER_APP })
      expect(text).toContain('Review the cases')
      expect(text).not.toContain('untouched')
      expect(digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: RESEARCHER_APP })).toBeNull()
    })

    it('never tells a sender its own message went unanswered', () => {
      const digest = createBoardDigest({ store })
      store.insertActivity({
        id: 'a-1', teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'message',
        actorAppId: RESEARCHER_APP, targetAppId: LEAD_APP, subject: 'confirm the spec',
        body: null, refId: 'a-1', correlationId: 'c-1', status: 'sent', createdAt: Date.now() - HOUR,
      })

      // A normal reply is a fresh message act with its own correlationId, so the
      // record can never show this one as answered. Reporting it would therefore
      // be permanent, not occasional — every send nagged for the epoch's life.
      expect(digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: RESEARCHER_APP })).toBeNull()
    })

    it('never nags about a message that was never delivered — there is nobody to answer it', () => {
      const digest = createBoardDigest({ store })
      store.insertActivity({
        id: 'a-1', teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'message',
        actorAppId: RESEARCHER_APP, targetAppId: LEAD_APP, subject: 'confirm the spec',
        body: null, refId: 'a-1', correlationId: 'c-1', status: 'undelivered', createdAt: Date.now() - HOUR,
      })
      expect(digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: RESEARCHER_APP })).toBeNull()
    })

    it('never quotes back a message the member already read as its own turn input', () => {
      const digest = createBoardDigest({ store })
      store.insertActivity({
        id: 'a-1', teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'message',
        actorAppId: LEAD_APP, targetAppId: RESEARCHER_APP, subject: 'confirm the spec',
        body: null, refId: 'a-1', correlationId: 'c-1', status: 'sent', createdAt: Date.now(),
      })
      expect(digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: RESEARCHER_APP })).toBeNull()
    })

    it('does report a message aimed at the member that never arrived', () => {
      const digest = createBoardDigest({ store })
      store.insertActivity({
        id: 'a-1', teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'message',
        actorAppId: LEAD_APP, targetAppId: RESEARCHER_APP, subject: 'confirm the spec',
        body: null, refId: 'a-1', correlationId: null, status: 'undelivered', createdAt: Date.now(),
      })
      expect(digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: RESEARCHER_APP })).toContain(
        'did not arrive'
      )
    })

    it('folds traffic between two other members into a count, keeping their words off the digest', () => {
      addWriter(store)
      const digest = createBoardDigest({ store })
      for (let i = 0; i < 4; i++) {
        const [from, to] = i % 2 === 0 ? [RESEARCHER_APP, WRITER_APP] : [WRITER_APP, RESEARCHER_APP]
        store.insertActivity({
          id: `a-${i}`, teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'message',
          actorAppId: from, targetAppId: to, subject: `small talk ${i}`,
          body: null, refId: `a-${i}`, correlationId: `c-${i}`, status: 'sent', createdAt: Date.now() + i,
        })
      }

      const text = digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: LEAD_APP })
      expect(text).toContain('researcher and writer exchanged 4 messages')
      expect(text).not.toContain('small talk')
    })

    it('spends the budget on what only the board carries before it spends it on chatter', () => {
      addWriter(store)
      const digest = createBoardDigest({ store })
      for (let i = 0; i < 6; i++) {
        store.insertActivity({
          id: `t-${i}`, teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'task_post',
          actorAppId: RESEARCHER_APP, targetAppId: WRITER_APP, subject: `Task ${i}`,
          body: null, refId: `task-${i}`, correlationId: null, status: null, createdAt: Date.now() + i,
        })
      }
      store.insertActivity({
        id: 'a-1', teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'message',
        actorAppId: RESEARCHER_APP, targetAppId: WRITER_APP, subject: 'small talk',
        body: null, refId: 'a-1', correlationId: 'c-1', status: 'sent', createdAt: Date.now() + 10,
      })

      const text = digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: LEAD_APP })
      expect(text).toContain('Task 5')
      expect(text).not.toContain('exchanged')
    })

    it('states that the record is partial, so a gap is never read as a verdict', () => {
      const board = createBlackboard({ store })
      const digest = createBoardDigest({ store })
      board.postActivity({
        teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'finding', actorAppId: LEAD_APP, subject: 'brief.md',
      })
      const text = digest.render({ teamId: TEAM_ID, epochId: EPOCH_ID, viewerAppId: RESEARCHER_APP })
      expect(text).toContain('not everything that happened')
    })
  })

  describe('message bus', () => {
    it('records every message it carries, and leaves it OPEN when the turn merely ends', async () => {
      const board = createBlackboard({ store })
      const bus = createMessageBus({
        store,
        recordActivity: (input) => board.postActivity(input),
        hooks: {
          wakeTarget: async () => {},
          isBusy: () => false,
        },
      })

      const result = await bus.send({
        teamId: TEAM_ID,
        epochId: EPOCH_ID,
        fromAppId: LEAD_APP,
        to: 'researcher',
        message: 'Confirm the field spec\nand reply when done',
      })
      const messageId = 'messageId' in result ? result.messageId : ''

      const acts = store.listActivityByEpoch(TEAM_ID, EPOCH_ID)
      expect(acts).toHaveLength(1)
      expect(acts[0]).toMatchObject({
        id: messageId,
        kind: 'message',
        actorAppId: LEAD_APP,
        targetAppId: RESEARCHER_APP,
        subject: 'Confirm the field spec',
        status: 'sent',
      })
      // The full text is kept; only the subject is the one-line form.
      expect(acts[0].body).toContain('reply when done')

      const correlationId = acts[0].correlationId!
      bus.completeTurn({
        sessionKey: buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, EPOCH_ID),
        trigger: {
          teamId: TEAM_ID,
          epochId: EPOCH_ID,
          correlationId,
          fromAppId: LEAD_APP,
          wait: false,
          kind: 'message',
        },
        outcome: { kind: 'result', content: 'Confirmed.' },
      })

      // A finished turn is not an answer: "Confirmed." went to whoever watches
      // the member's own chat, never to the lead. Filing it as a reply would quote
      // that closing line back at the lead as though it had been sent to them.
      const afterTurn = store.listActivityByEpoch(TEAM_ID, EPOCH_ID)
      expect(afterTurn).toHaveLength(1)
      expect(afterTurn.some((a) => a.kind === 'reply')).toBe(false)
    })

    it('closes a message when its turn FAILED — a fate the sender cannot learn any other way', async () => {
      const board = createBlackboard({ store })
      const bus = createMessageBus({
        store,
        recordActivity: (input) => board.postActivity(input),
        hooks: { wakeTarget: async () => {}, isBusy: () => false },
      })

      await bus.send({
        teamId: TEAM_ID,
        epochId: EPOCH_ID,
        fromAppId: LEAD_APP,
        to: 'researcher',
        message: 'Confirm the field spec',
      })
      const correlationId = store.listActivityByEpoch(TEAM_ID, EPOCH_ID)[0].correlationId!

      bus.completeTurn({
        sessionKey: buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, EPOCH_ID),
        trigger: {
          teamId: TEAM_ID,
          epochId: EPOCH_ID,
          correlationId,
          fromAppId: LEAD_APP,
          wait: false,
          kind: 'message',
        },
        outcome: { kind: 'timeout' },
      })

      const acts = store.listActivityByEpoch(TEAM_ID, EPOCH_ID)
      expect(acts).toHaveLength(2)
      expect(acts.find((a) => a.kind === 'reply')).toMatchObject({
        actorAppId: RESEARCHER_APP,
        targetAppId: LEAD_APP,
        status: 'timeout',
        correlationId,
      })
    })

    it("a person's 1:1 message is delivered and leaves no trace — theirs to have, not the office's to keep", async () => {
      const board = createBlackboard({ store })
      const woken: string[] = []
      const bus = createMessageBus({
        store,
        recordActivity: (input) => board.postActivity(input),
        hooks: {
          wakeTarget: async (p) => {
            woken.push(p.appId)
          },
          isBusy: () => false,
        },
      })

      const result = await bus.send({
        teamId: TEAM_ID,
        epochId: EPOCH_ID,
        fromAppId: null,
        to: 'researcher',
        message: 'are you free for a quick question?',
        wait: false,
      })

      // Delivered — that is the whole point of riding the bus.
      expect(woken).toEqual([RESEARCHER_APP])
      expect('messageId' in result).toBe(true)
      // ...and nothing about it reached the shared record.
      expect(store.listActivityByEpoch(TEAM_ID, EPOCH_ID)).toHaveLength(0)
    })

    it("a person's message costs nothing against the run's budget", async () => {
      // The circuit breaker guards digital humans ping-ponging unsupervised. A
      // person cannot loop, and charging them let a chat burn the run's
      // allowance — and start its clock — before the team began working.
      const bus = createMessageBus({
        store,
        hooks: { wakeTarget: async () => {}, isBusy: () => false },
      })

      await bus.send({
        teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: null,
        to: 'researcher', message: 'morning', wait: false,
      })
      expect(bus.getEpochStats(EPOCH_ID)).toMatchObject({ messageCount: 0, firstSendAt: null })

      await bus.send({
        teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP,
        to: 'researcher', message: 'start on T1', wait: false,
      })
      expect(bus.getEpochStats(EPOCH_ID).messageCount).toBe(1)
    })

    it("a person's turn is not reported to the office as a teammate's answer", async () => {
      // completeTurn closes the loop for a teammate send with a `reply` act. A
      // person's send has no message row to answer, so a reply row would show
      // up on everyone's board as an answer to nobody.
      const board = createBlackboard({ store })
      const bus = createMessageBus({
        store,
        recordActivity: (input) => board.postActivity(input),
        hooks: { wakeTarget: async () => {}, isBusy: () => false },
      })

      await bus.send({
        teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: null,
        to: 'researcher', message: 'quick question', wait: false,
      })
      bus.completeTurn({
        sessionKey: buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, EPOCH_ID),
        trigger: {
          teamId: TEAM_ID, epochId: EPOCH_ID, correlationId: 'c-human',
          fromAppId: null, wait: false, kind: 'human_message',
        },
        outcome: { kind: 'result', content: 'Sure.' },
      })

      expect(store.listActivityByEpoch(TEAM_ID, EPOCH_ID)).toHaveLength(0)
    })
  })
})
