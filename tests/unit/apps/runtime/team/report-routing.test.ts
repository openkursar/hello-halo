/**
 * Unit tests for the team report routing in report-tool.ts.
 *
 * The report_to_user tool keeps its original purpose in a team turn:
 *   - escalation → a user-facing entry is written TAGGED with teamContext (for
 *     cross-epoch aggregation) AND captured to the team runtime as an escalation; the
 *     escalation event is still broadcast.
 *   - non-escalation (run_complete/output/...) → NOT captured as a result (the
 *     result is the turn's final message); falls through to a normal audit entry.
 *   - no teamContext (native / IM turn) → behavior is unchanged.
 *
 * The SDK tool() is mocked so the handler is directly invokable; the team
 * runtime accessor and the event/notification sinks are mocked so the routing
 * is observable without Electron.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { toolMock, createSdkMcpServerMock } = vi.hoisted(() => ({
  toolMock: vi.fn((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    schema,
    handler,
  })),
  createSdkMcpServerMock: vi.fn((opts: any) => ({ name: opts.name, tools: opts.tools })),
}))
vi.mock('../../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: toolMock,
  createSdkMcpServer: createSdkMcpServerMock,
}))

const { broadcastToAll, sendToRenderer, notifyAppEvent, getActiveTeamRuntime } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
  notifyAppEvent: vi.fn(),
  getActiveTeamRuntime: vi.fn(),
}))
vi.mock('../../../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../../../src/main/foundation/window.service', () => ({ sendToRenderer }))
vi.mock('../../../../../src/main/services/notification.service', () => ({ notifyAppEvent }))
vi.mock('../../../../../src/main/apps/runtime/team', () => ({ getActiveTeamRuntime }))

import { createReportToolServer } from '../../../../../src/main/apps/runtime/report-tool'
import type { ReportToolContext } from '../../../../../src/main/apps/runtime/report-tool'
import type { ActivityEntry } from '../../../../../src/main/apps/runtime/types'

// ============================================
// Helpers
// ============================================

function makeStore() {
  const entries: ActivityEntry[] = []
  return {
    entries,
    store: {
      insertEntry: vi.fn((e: ActivityEntry) => entries.push(e)),
      getAllPendingEscalations: vi.fn(() =>
        entries.filter((e) => e.type === 'escalation' && !e.userResponse)
      ),
    } as any,
  }
}

/** Build the server and return the single report tool's handler. */
function getReportHandler(ctx: ReportToolContext, store: any, emitEntry?: (e: ActivityEntry) => void) {
  createReportToolServer(store, ctx, undefined, emitEntry)
  const lastCall = toolMock.mock.calls[toolMock.mock.calls.length - 1]
  return lastCall[3] as (input: any) => Promise<any>
}

const TRIGGER = {
  teamId: 'team-1',
  epochId: 'epoch-1',
  correlationId: 'corr-1',
  fromAppId: 'app-lead',
  wait: false,
  taskId: 'task-7',
}

// ============================================
// Tests
// ============================================

describe('report routing (§5.3)', () => {
  let capture: ReturnType<typeof vi.fn>

  beforeEach(() => {
    toolMock.mockClear()
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
    notifyAppEvent.mockClear()
    capture = vi.fn()
    // Default routing = 'user': the escalation surfaces to the user.
    getActiveTeamRuntime.mockReturnValue({
      captureReport: capture,
      buildPromptContext: vi.fn(() => ({ escalationRouting: 'user' })),
    })
  })

  it('team non-escalation report → NOT captured as a result; writes a normal audit entry', async () => {
    const { store, entries } = makeStore()
    const ctx: ReportToolContext = {
      appId: 'app-researcher',
      appName: 'Researcher',
      runId: 'chat',
      sessionKey: 'app-chat:app-researcher:team:team-1',
      teamContext: TRIGGER,
    }
    const handler = getReportHandler(ctx, store)
    const res = await handler({ type: 'run_complete', summary: 'T1 done', data: 'see out.md' })

    // The result is the turn's final message — report does NOT carry it.
    expect(capture).not.toHaveBeenCalled()
    // Falls through to the normal path: an ordinary (audit) entry is written.
    expect(entries).toHaveLength(1)
    expect(entries[0].content.summary).toBe('T1 done')
    expect(entries[0].content.teamContext).toBeUndefined()
    expect(res.content[0].text).toMatch(/report saved/i)
  })

  it('team escalation → tagged entry written AND captured as report_escalation', async () => {
    const { store, entries } = makeStore()
    const ctx: ReportToolContext = {
      appId: 'app-researcher',
      appName: 'Researcher',
      runId: 'chat',
      sessionKey: 'app-chat:app-researcher:team:team-1',
      teamContext: TRIGGER,
    }
    const handler = getReportHandler(ctx, store)
    const res = await handler({
      type: 'escalation',
      summary: 'Data source 403',
      question: 'Skip or wait?',
      choices: ['skip', 'wait'],
    })

    // Captured for orchestration routing.
    expect(capture).toHaveBeenCalledWith('corr-1', {
      kind: 'escalation',
      content: 'Data source 403',
    })
    // Entry written, tagged with teamContext for aggregation.
    expect(entries).toHaveLength(1)
    expect(entries[0].type).toBe('escalation')
    expect(entries[0].content.teamContext).toEqual({
      teamId: 'team-1',
      epochId: 'epoch-1',
      taskId: 'task-7',
    })
    // Escalation event broadcast for the UI.
    expect(broadcastToAll).toHaveBeenCalledWith('app:escalation:new', expect.objectContaining({ appId: 'app-researcher' }))
    expect(res.content[0].text).toMatch(/escalation sent to user/i)
  })

  it('team escalation with routing=lead → captured + audited, but NOT surfaced to the user', async () => {
    getActiveTeamRuntime.mockReturnValue({
      captureReport: capture,
      // A MEMBER (not the lead) under lead routing → suppressed (forwarded to lead).
      buildPromptContext: vi.fn(() => ({ escalationRouting: 'lead', selfIsLead: false })),
    })
    const { store, entries } = makeStore()
    const onEscalation = vi.fn()
    const ctx: ReportToolContext = {
      appId: 'app-researcher',
      appName: 'Researcher',
      runId: 'chat',
      sessionKey: 'app-chat:app-researcher:team:team-1',
      teamContext: TRIGGER,
    }
    createReportToolServer(store, ctx, onEscalation)
    const lastCall = toolMock.mock.calls[toolMock.mock.calls.length - 1]
    const handler = lastCall[3] as (input: any) => Promise<any>
    const res = await handler({
      type: 'escalation',
      summary: 'Data source 403',
      question: 'Skip or wait?',
    })

    // Still captured for the runtime to route to the lead.
    expect(capture).toHaveBeenCalledWith('corr-1', { kind: 'escalation', content: 'Data source 403' })
    // Audit entry still written (tagged) for aggregation.
    expect(entries).toHaveLength(1)
    expect(entries[0].type).toBe('escalation')
    // The user is NOT prompted: no callback, no broadcast, no desktop notification.
    expect(onEscalation).not.toHaveBeenCalled()
    expect(broadcastToAll).not.toHaveBeenCalled()
    expect(sendToRenderer).not.toHaveBeenCalled()
    expect(notifyAppEvent).not.toHaveBeenCalled()
    expect(res.content[0].text).toMatch(/routed to the team lead/i)
  })

  it('the LEAD\u2019s own escalation under routing=lead → surfaced to the user (not suppressed)', async () => {
    // The lead is the last resort before the user: when it escalates upward it
    // must reach the user even under 'lead' routing, otherwise it is lost.
    getActiveTeamRuntime.mockReturnValue({
      captureReport: capture,
      buildPromptContext: vi.fn(() => ({ escalationRouting: 'lead', selfIsLead: true })),
    })
    const { store, entries } = makeStore()
    const onEscalation = vi.fn()
    const ctx: ReportToolContext = {
      appId: 'app-lead',
      appName: 'Lead',
      runId: 'chat',
      sessionKey: 'app-chat:app-lead:team:team-1',
      teamContext: TRIGGER,
    }
    createReportToolServer(store, ctx, onEscalation)
    const lastCall = toolMock.mock.calls[toolMock.mock.calls.length - 1]
    const handler = lastCall[3] as (input: any) => Promise<any>
    const res = await handler({ type: 'escalation', summary: 'Cannot resolve', question: 'Your call?' })

    // Surfaced to the user: callback + broadcast fire, entry tagged with teamId.
    expect(onEscalation).toHaveBeenCalledWith(entries[0].id)
    expect(broadcastToAll).toHaveBeenCalledWith(
      'app:escalation:new',
      expect.objectContaining({ appId: 'app-lead', teamId: 'team-1', epochId: 'epoch-1' })
    )
    expect(res.content[0].text).toMatch(/escalation sent to user/i)
  })

  it('a team escalation is told its turn is not suspended (teammates still wake it)', async () => {
    const { store } = makeStore()
    const ctx: ReportToolContext = {
      appId: 'app-researcher',
      appName: 'Researcher',
      runId: 'chat',
      sessionKey: 'app-chat:app-researcher:team:team-1',
      teamContext: TRIGGER,
    }
    const handler = getReportHandler(ctx, store)
    const res = await handler({ type: 'escalation', summary: 'Data source 403', question: 'Skip or wait?' })

    // A member believing it is suspended reads the next unrelated wake as its answer.
    const text = res.content[0].text as string
    expect(text).toMatch(/stays open until the user answers/i)
    expect(text).toMatch(/still be woken for other work/i)
    expect(text).not.toMatch(/you will be\s+resumed/i)
  })

  it('a second escalation names the ones still unanswered', async () => {
    const { store, entries } = makeStore()
    const ctx: ReportToolContext = {
      appId: 'app-researcher',
      appName: 'Researcher',
      runId: 'chat',
      sessionKey: 'app-chat:app-researcher:team:team-1',
      teamContext: TRIGGER,
    }
    const handler = getReportHandler(ctx, store)
    await handler({ type: 'escalation', summary: 'first', question: 'Which test account\nshould I use?' })
    const res = await handler({ type: 'escalation', summary: 'second', question: 'Ship without the VDI?' })

    expect(entries).toHaveLength(2)
    const text = res.content[0].text as string
    // Multi-line questions are inlined so one quoted question cannot read as
    // several separate instructions.
    expect(text).toContain('1 earlier question(s) still unanswered: "Which test account should I use?"')
    expect(text).not.toContain('Ship without the VDI?')
  })

  it('the first escalation of an app names no others', async () => {
    const { store } = makeStore()
    const ctx: ReportToolContext = {
      appId: 'app-researcher',
      appName: 'Researcher',
      runId: 'chat',
      sessionKey: 'app-chat:app-researcher:team:team-1',
      teamContext: TRIGGER,
    }
    const handler = getReportHandler(ctx, store)
    const res = await handler({ type: 'escalation', summary: 'only one', question: 'Go?' })

    expect(res.content[0].text as string).not.toMatch(/still unanswered/i)
  })

  it('non-team turn → unchanged: a normal activity entry is written', async () => {
    const { store, entries } = makeStore()
    const ctx: ReportToolContext = {
      appId: 'app-solo',
      appName: 'Solo',
      runId: 'chat',
      sessionKey: 'app-chat:app-solo',
      // no teamContext
    }
    const handler = getReportHandler(ctx, store)
    const res = await handler({ type: 'run_complete', summary: 'done' })

    expect(capture).not.toHaveBeenCalled()
    expect(entries).toHaveLength(1)
    expect(entries[0].content.summary).toBe('done')
    expect(entries[0].content.teamContext).toBeUndefined()
    expect(res.content[0].text).toMatch(/report saved/i)
  })
})
