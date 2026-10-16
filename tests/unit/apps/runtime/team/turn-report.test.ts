import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  createTurnReport,
  REPORT_WAKE_CAP,
  FINAL_REPLY_LIMIT,
  REQUEST_SUMMARY_LIMIT,
  REMOTE_FLUSH_WINDOW_MS,
  MAX_TIMED_RETRIES,
  FACTS_PER_NOTICE,
  readTurnEndReport,
  renderTurnEndReport,
} from '../../../../../src/main/apps/runtime/team/turn-report'
import type { TurnReport } from '../../../../../src/main/apps/runtime/team/turn-report'
import type { MessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import type { TeamStore } from '../../../../../src/main/apps/team'

// ============================================
// Helpers
// ============================================

const TEAM = 'team-1'
const EPOCH = 'epoch-1'
const LEAD = 'app-lead'

interface FakeMember {
  appId: string
  memberName: string
  origin?: 'local' | 'remote'
  ownerNodeId?: string
}

function makeStore(members: FakeMember[], opts?: { sealed?: boolean }) {
  return {
    getTeamById: vi.fn(() => ({ id: TEAM, leadAppId: LEAD, collabMode: 'free' })),
    getEpochById: vi.fn(() => ({ id: EPOCH, endedAt: opts?.sealed ? Date.now() : null })),
    getMember: vi.fn((_teamId: string, appId: string) => members.find((m) => m.appId === appId) ?? null),
    getTaskById: vi.fn(() => ({ title: 'draft outline' })),
  } as unknown as TeamStore
}

function makeBus() {
  const wakes: { toAppId: string; body: string; kind?: string; origin?: string; turnEnded?: unknown }[] = []
  const tripExternal = vi.fn()
  const bus = {
    deliverRuntimeWake: vi.fn(async (params: any) => {
      wakes.push({
        toAppId: params.envelope.toAppId,
        body: params.envelope.body,
        kind: params.trigger.kind,
        origin: params.trigger.origin,
        turnEnded: params.trigger.turnEnded,
      })
      return 'dispatched'
    }),
    tripExternal,
  } as unknown as MessageBus
  return { bus, wakes, tripExternal }
}

function makeReport(
  members: FakeMember[],
  bus: MessageBus,
  opts?: { sealed?: boolean }
): TurnReport {
  return createTurnReport({
    store: makeStore(members, opts),
    bus,
  })
}

function endCollaboration(report: TurnReport, input: Parameters<TurnReport['noteTurnEnded']>[0]): void {
  report.noteTurnEnded({ triggerKind: 'message', ...input })
}

/** Run a whole turn for a member, with the acts it filed in between. */
function runTurn(
  report: TurnReport,
  appId: string,
  acts: { kind: string; targetAppId?: string; refId?: string }[],
  end?: Parameters<TurnReport['noteTurnEnded']>[0]
): void {
  report.noteTurnStarted({ appId, teamId: TEAM, epochId: EPOCH })
  for (const act of acts) {
    report.noteAct({
      teamId: TEAM,
      epochId: EPOCH,
      kind: act.kind as any,
      actorAppId: appId,
      targetAppId: act.targetAppId ?? null,
      refId: act.refId ?? null,
      subject: 'x',
    })
  }
  endCollaboration(report, end ?? { appId, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
}

/** The one line about a member, isolated from the notice's standing footer. */
function lineFor(body: string, memberName: string): string {
  return body.split('\n').find((l) => l.startsWith(`- ${memberName} —`)) ?? ''
}

const LOCAL_TEAM: FakeMember[] = [
  { appId: LEAD, memberName: 'Lead' },
  { appId: 'app-writer', memberName: 'writer' },
  { appId: 'app-editor', memberName: 'editor' },
]

// ============================================
// Tests
// ============================================

describe('turn-end report', () => {
  let bus: MessageBus
  let wakes: { toAppId: string; body: string; kind?: string; origin?: string; turnEnded?: unknown }[]
  let tripExternal: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;({ bus, wakes, tripExternal } = makeBus())
  })

  it.each(['ended', 'error', 'stopped', 'timeout'] as const)('unknown-source %s endings never wake the lead or reveal excerpts', async kind => {
    const report = makeReport(LOCAL_TEAM, bus)
    report.noteTurnStarted({ appId: 'app-writer', teamId: TEAM, epochId: EPOCH })
    report.noteTurnEnded({ appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: kind === 'error' ? { kind, message: 'private failure' } : { kind }, requestSummary: 'private request', finalReply: 'private answer' })
    endCollaboration(report, { appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await Promise.resolve()
    expect(wakes).toHaveLength(0)
  })

  it.each([
    { memberAllowed: false, requesterAllowed: true, requester: 'app-editor', visible: false },
    { memberAllowed: true, requesterAllowed: false, requester: 'app-editor', visible: false },
    { memberAllowed: true, requesterAllowed: true, requester: undefined, visible: false },
    { memberAllowed: true, requesterAllowed: true, requester: 'app-editor', visible: true },
    { memberAllowed: true, requesterAllowed: false, requester: LEAD, visible: true },
  ])('keeps lifecycle notices while restricting excerpts: %j', async scenario => {
    const store = makeStore(LOCAL_TEAM)
    vi.mocked(store.getTeamById).mockReturnValue({ id: TEAM, leadAppId: LEAD, collabMode: 'structured' } as any)
    store.isEdgeAllowed = vi.fn((_team, from, to) => from === LEAD && (
      to === 'app-writer' ? scenario.memberAllowed : to === 'app-editor' && scenario.requesterAllowed
    ))
    const report = createTurnReport({ store, bus })
    runTurn(report, 'app-writer', [{ kind: 'task_update', refId: 'private-task' }], {
      appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'error', message: 'private failure' },
      requestSummary: 'private request', finalReply: 'private answer', requestFromAppId: scenario.requester,
    })
    await vi.waitFor(() => expect(wakes).toHaveLength(1))
    expect(wakes[0].body).toContain('writer — stopped with an error')
    for (const text of ['private request', 'private answer', 'private failure', 'draft outline']) {
      expect(wakes[0].body.includes(text)).toBe(scenario.visible)
    }
  })

  it('checks topology immediately before handing a fact to the delivery core', async () => {
    const store = makeStore(LOCAL_TEAM)
    vi.mocked(store.getTeamById).mockReturnValue({ id: TEAM, leadAppId: LEAD, collabMode: 'structured' } as any)
    store.isEdgeAllowed = vi.fn(() => false)
    const report = createTurnReport({ store, bus })
    runTurn(report, 'app-writer', [], {
      appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' },
      requestFromAppId: LEAD, requestSummary: 'private request', finalReply: 'private answer',
    })
    expect(wakes).toHaveLength(1)
    expect(wakes[0].body).not.toContain('private')
  })

  it('an acknowledgement does not suppress the bounded request and final reply fallback', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [{ kind: 'message', targetAppId: LEAD }], {
      appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' },
      requestSummary: 'Review the proposal. '.repeat(100), finalReply: '🙂'.repeat(700),
    })
    await vi.waitFor(() => expect(wakes).toHaveLength(1))
    const requestLine = wakes[0].body.split('\n').find(line => line.startsWith('  Request excerpt: '))!
    const replyLine = wakes[0].body.split('\n').find(line => line.startsWith('  Final reply excerpt'))!
    expect(Array.from(JSON.parse(requestLine.slice(requestLine.indexOf(': ') + 2)))).toHaveLength(REQUEST_SUMMARY_LIMIT)
    expect(Array.from(JSON.parse(replyLine.slice(replyLine.indexOf(': ') + 2)))).toHaveLength(FINAL_REPLY_LIMIT)
    expect(wakes[0].body).toContain('not a completion claim')
    expect(wakes[0].body).toContain('A manual stop must not be automatically restarted or reassigned')
  })

  it.each([LEAD, 'app-editor'])('notifies the lead after a member sends its result to %s', async targetAppId => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [{ kind: 'message', targetAppId }], {
      appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' },
      requestSummary: 'Review the proposal', finalReply: 'Review finished and result sent.',
    })
    await vi.waitFor(() => expect(wakes).toHaveLength(1))
    expect(wakes[0].body).toContain('Review finished and result sent.')
    expect(wakes[0].body).not.toContain('No explicit result delivery')
  })

  it.each(['sealed', 'completed'])('closed tasks never hand another notice to the mailbox: %s', async state => {
    const store = makeStore(LOCAL_TEAM)
    vi.mocked(store.getEpochById).mockReturnValue({ id: EPOCH, endedAt: state === 'sealed' ? Date.now() : null, workItem: { status: state === 'completed' ? 'completed' : 'open' } } as any)
    const report = createTurnReport({ store, bus })
    runTurn(report, 'app-writer', [])
    expect(wakes).toHaveLength(0)
  })

  it('wakes the lead when a member stops, and says what it filed', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [
      { kind: 'message', targetAppId: LEAD },
      { kind: 'task_update', refId: 'task-1' },
    ])
    await vi.waitFor(() => expect(wakes).toHaveLength(1))

    expect(wakes[0].toAppId).toBe(LEAD)
    expect(wakes[0].kind).toBe('member_stopped')
    expect(wakes[0].body).toContain('writer — stopped with no error reported')
    expect(wakes[0].body).toContain('messaged Lead')
    expect(wakes[0].body).toContain('moved "draft outline"')
  })

  it('a notice about what a guest\u2019s request produced wakes the lead as the guest\u2019s, for that wake only', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [], {
      appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' }, origin: 'guest',
    })
    await vi.waitFor(() => expect(wakes).toHaveLength(1))
    expect(wakes[0].kind).toBe('member_stopped')
    expect(wakes[0].origin).toBe('guest')

    runTurn(report, 'app-writer', [])
    await vi.waitFor(() => expect(wakes).toHaveLength(2))
    expect(wakes[1].origin).toBeUndefined()
  })

  it('a notice about a colleague\u2019s request is the lead\u2019s to weigh with the owner\u2019s reach', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [], {
      appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' }, origin: 'colleague',
    })
    await vi.waitFor(() => expect(wakes).toHaveLength(1))
    expect(wakes[0].origin).toBeUndefined()
  })

  it('a notice about work started here carries no outside origin', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [])
    await vi.waitFor(() => expect(wakes).toHaveLength(1))
    expect(wakes[0].origin).toBeUndefined()
    // A lead on this machine reads the notice it is handed; nothing to render elsewhere.
    expect(wakes[0].turnEnded).toBeUndefined()
  })

  it('keeps a guest\u2019s endings apart from the rest for permission-aware delivery', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [], { appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' }, origin: 'colleague' })
    runTurn(report, 'app-editor', [], {
      appId: 'app-editor', teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' }, origin: 'guest',
    })
    await vi.waitFor(() => expect(wakes).toHaveLength(2))
    expect(wakes[0].origin).toBeUndefined()
    expect(wakes[1].origin).toBe('guest')
    expect(wakes[0].body).not.toContain('editor —')
    expect(wakes[1].body).not.toContain('writer —')
  })

  it('never says the work is done — "no error" is stated as exactly that', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [{ kind: 'message', targetAppId: LEAD }])
    await vi.waitFor(() => expect(wakes).toHaveLength(1))

    expect(wakes[0].body).not.toMatch(/completed|finished|success/i)
    expect(wakes[0].body).toContain('It is NOT a claim that the work is done')
  })

  it('a member that stopped having filed nothing is called out', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-editor', [])
    await vi.waitFor(() => expect(wakes).toHaveLength(1))

    expect(lineFor(wakes[0].body, 'editor')).toContain('filed nothing during that turn')
  })

  it('an unwatched turn makes no claim about what was filed', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    // No noteTurnStarted: the process did not see this turn begin.
    endCollaboration(report, { appId: 'app-editor', teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await vi.waitFor(() => expect(wakes).toHaveLength(1))

    expect(lineFor(wakes[0].body, 'editor')).toBe('- editor — stopped with no error reported.')
  })

  it('a failure is passed through as the member saw it, on one line', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [], {
      appId: 'app-writer',
      teamId: TEAM,
      epochId: EPOCH,
      fate: { kind: 'error', message: 'Session closed\nunexpectedly' },
    })
    await vi.waitFor(() => expect(wakes).toHaveLength(1))

    expect(wakes[0].body).toContain('stopped with an error: Session closed unexpectedly')
  })

  it('a wake that never became a turn says so, and claims nothing about the member', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    endCollaboration(report, {
      appId: 'app-writer',
      teamId: TEAM,
      epochId: EPOCH,
      fate: { kind: 'never_ran', reason: 'owner offline' },
    })
    await vi.waitFor(() => expect(wakes).toHaveLength(1))

    expect(lineFor(wakes[0].body, 'writer')).toBe(
      '- writer — never ran — the wake did not reach them: owner offline.'
    )
  })

  it('a hand-stopped member is reported distinctly from a crash, so the lead is not sent chasing it', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [], {
      appId: 'app-writer',
      teamId: TEAM,
      epochId: EPOCH,
      fate: { kind: 'stopped' },
    })
    await vi.waitFor(() => expect(wakes).toHaveLength(1))

    const line = lineFor(wakes[0].body, 'writer')
    expect(line).toContain('was stopped by hand — not a failure')
    expect(line).not.toMatch(/error/i)
  })

  it("a person's turn with their own member never wakes the lead, and never even enters the queue", async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [], {
      appId: 'app-writer',
      teamId: TEAM,
      epochId: EPOCH,
      fate: { kind: 'ended' },
      triggerKind: 'human_message',
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(wakes).toHaveLength(0)

    endCollaboration(report, { appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(wakes).toHaveLength(0)
  })

  it("the lead's own ending never wakes the lead", async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, LEAD, [{ kind: 'message', targetAppId: 'app-writer' }])
    await new Promise((r) => setTimeout(r, 0))

    expect(wakes).toHaveLength(0)
  })

  it('hands each ending to the shared delivery core at once, never superseding an earlier one', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [])
    await Promise.resolve()
    runTurn(report, 'app-editor', [])
    await Promise.resolve()
    runTurn(report, 'app-writer', [])
    const reported = (name: string) => wakes.flatMap((wake) => wake.body.split('\n')).filter((line) => line.startsWith(`- ${name} —`))
    await vi.waitFor(() => expect(reported('writer')).toHaveLength(2))
    expect(reported('editor')).toHaveLength(1)
    // The first ending went out alone; the two that landed meanwhile share the next notice.
    expect(wakes).toHaveLength(2)
    const calls = vi.mocked(bus.deliverRuntimeWake).mock.calls
    expect(calls.every(([request]) => request.coalescingKey === undefined)).toBe(true)
    endCollaboration(report, { appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    expect(wakes).toHaveLength(2)
  })

  it('keeps every ending of the same member that piled up while a notice was going out', async () => {
    let release!: () => void
    vi.mocked(bus.deliverRuntimeWake).mockImplementationOnce(async (params: any) => {
      wakes.push({ toAppId: params.envelope.toAppId, body: params.envelope.body, kind: params.trigger.kind })
      await new Promise<void>(resolve => { release = resolve })
      return 'dispatched'
    })
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-editor', [])
    await vi.waitFor(() => expect(wakes).toHaveLength(1))
    runTurn(report, 'app-writer', [], { appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'error', message: 'first failure' } })
    runTurn(report, 'app-writer', [], { appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'timeout' } })
    release()
    await vi.waitFor(() => expect(wakes).toHaveLength(2))
    expect(wakes[1].body).toContain('first failure')
    expect(wakes[1].body).toContain('cut off for running past the turn time limit')
  })

  it('the machine that did not run the turn stays quiet about how it ended', async () => {
    const remoteMember: FakeMember[] = [
      { appId: LEAD, memberName: 'Lead' },
      { appId: 'app-writer', memberName: 'writer', origin: 'remote', ownerNodeId: 'node-b' },
    ]
    const report = makeReport(remoteMember, bus)

    // Its owner witnessed this and reports it there; a second notice here would
    // announce the same ending twice.
    endCollaboration(report, { appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(wakes).toHaveLength(0)

    // Nothing ran anywhere, so the waiting side is the only witness there is.
    endCollaboration(report, {
      appId: 'app-writer',
      teamId: TEAM,
      epochId: EPOCH,
      fate: { kind: 'never_ran', reason: 'owner offline' },
    })
    await vi.waitFor(() => expect(wakes).toHaveLength(1))
  })

  it('one ending is announced once, however many reporters saw it', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    const ending = {
      appId: 'app-writer',
      teamId: TEAM,
      epochId: EPOCH,
      correlationId: 'corr-1',
    }
    endCollaboration(report, { ...ending, fate: { kind: 'timeout' } })
    endCollaboration(report, { ...ending, fate: { kind: 'error', message: 'aborted' } })
    await vi.waitFor(() => expect(wakes).toHaveLength(1))

    expect(wakes[0].body).toContain('cut off for running past the turn time limit')
    expect(wakes[0].body).not.toContain('aborted')
  })

  it('a sealed epoch has nobody left to coordinate', async () => {
    const report = makeReport(LOCAL_TEAM, bus, { sealed: true })
    runTurn(report, 'app-writer', [])
    await new Promise((r) => setTimeout(r, 0))

    expect(wakes).toHaveLength(0)
  })

  it('acts filed before this turn began are not attributed to it', async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [{ kind: 'message', targetAppId: LEAD }])
    await vi.waitFor(() => expect(wakes).toHaveLength(1))
    endCollaboration(report, { appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })

    // A second turn that does nothing must not inherit the first turn's
    // message — the real delay matters here (not just event ordering): both
    // turns' timestamps must land in different milliseconds for act
    // attribution (`a.at >= since`) to tell them apart at all.
    await new Promise((r) => setTimeout(r, 2))
    runTurn(report, 'app-writer', [])
    endCollaboration(report, { appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await vi.waitFor(() => expect(wakes).toHaveLength(2))
    expect(lineFor(wakes[1].body, 'writer')).toContain('filed nothing during that turn')
  })

  it(
    'trips the independent report-wake cap via the same breach channel message-volume limits use, ' +
      'without ever touching the message-volume counter itself',
    async () => {
      const report = makeReport(LOCAL_TEAM, bus)

      // Separate accepted handoffs so this tests the cap, not member coalescing.
      for (let i = 0; i < REPORT_WAKE_CAP; i++) {
        runTurn(report, 'app-writer', [])
        await new Promise<void>(resolve => setImmediate(resolve))
        endCollaboration(report, { appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
      }
      await vi.waitFor(() => expect(wakes).toHaveLength(REPORT_WAKE_CAP))
      expect(tripExternal).not.toHaveBeenCalled()

      // One more crosses it. Wait on tripExternal itself, not just wakes'
      // length: the mock pushes to `wakes` before `deliverRuntimeWake`
      // resolves, which is before flush()'s own continuation (the counter
      // bump + tripExternal call) runs — waiting on wakes alone would race
      // ahead of that continuation.
      runTurn(report, 'app-writer', [])
      endCollaboration(report, { appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
      await vi.waitFor(() => expect(tripExternal).toHaveBeenCalled())
      expect(tripExternal).toHaveBeenCalledWith(TEAM, EPOCH, 'turnReportFlood')
    }
  )

  it('does not count notices read inside the lead\'s running turn toward the report-wake cap', async () => {
    // A lead holding one long turn reads every member ending at a tool boundary;
    // none of those woke it, so a long run must not trip the flood breaker.
    vi.mocked(bus.deliverRuntimeWake).mockImplementation(async (params: any) => {
      wakes.push({ toAppId: params.envelope.toAppId, body: params.envelope.body, kind: params.trigger.kind })
      return 'mid_turn'
    })
    const report = makeReport(LOCAL_TEAM, bus)
    for (let i = 0; i < REPORT_WAKE_CAP + 1; i++) {
      runTurn(report, 'app-writer', [])
      await new Promise<void>(resolve => setImmediate(resolve))
      endCollaboration(report, { appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    }
    await vi.waitFor(() => expect(wakes).toHaveLength(REPORT_WAKE_CAP + 1))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(tripExternal).not.toHaveBeenCalled()
  })
})


describe('turn-end notices to a lead on another machine', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const REMOTE_LEAD_TEAM: FakeMember[] = [
    { appId: LEAD, memberName: 'Lead', origin: 'remote', ownerNodeId: 'node-b' },
    { appId: 'app-writer', memberName: 'writer' },
    { appId: 'app-editor', memberName: 'editor' },
  ]

  it('sends an isolated ending at once and carries a burst in one notice, so an older lead is woken once', async () => {
    const { bus, wakes } = makeBus()
    vi.mocked(bus.deliverRuntimeWake).mockImplementation(async (params: any) => {
      wakes.push({ toAppId: params.envelope.toAppId, body: params.envelope.body, kind: params.trigger.kind })
      return 'remote_accepted'
    })
    const report = makeReport(REMOTE_LEAD_TEAM, bus)
    runTurn(report, 'app-writer', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(1)

    runTurn(report, 'app-editor', [])
    runTurn(report, 'app-writer', [], { appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'timeout' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(REMOTE_FLUSH_WINDOW_MS)
    expect(wakes).toHaveLength(2)
    expect(lineFor(wakes[1].body, 'editor')).toContain('stopped with no error reported')
    expect(lineFor(wakes[1].body, 'writer')).toContain('cut off for running past the turn time limit')
    report.clearEpoch(EPOCH)
  })

  it('sends the facts with the notice, so the lead\u2019s machine renders it in its own words', async () => {
    const { bus } = makeBus()
    const triggers: any[] = []
    vi.mocked(bus.deliverRuntimeWake).mockImplementation(async (params: any) => {
      triggers.push(params.trigger)
      expect(params.envelope.body).toBe(renderTurnEndReport(params.trigger.turnEnded))
      return 'remote_accepted'
    })
    const report = makeReport(REMOTE_LEAD_TEAM, bus)
    runTurn(report, 'app-writer', [], {
      appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'error', message: 'boom' },
      triggerKind: 'message', requestSummary: 'do it', finalReply: 'partly', requestFromAppId: 'app-editor',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(triggers).toHaveLength(1)
    expect(readTurnEndReport(triggers[0].turnEnded)).toEqual(triggers[0].turnEnded)
    expect(triggers[0].turnEnded.endings[0]).toEqual(expect.objectContaining({ memberName: 'writer', fate: { kind: 'error', message: 'boom' } }))
    // Who asked stays on this machine: the facts describe the ending only.
    expect(JSON.stringify(triggers[0].turnEnded)).not.toContain('app-editor')
    report.clearEpoch(EPOCH)
  })
})

describe('a turn-end report that arrived from another machine', () => {
  const ending = { memberName: 'writer', fate: { kind: 'ended' }, did: [] as string[] }

  it('is read only in the shape this machine writes', () => {
    expect(readTurnEndReport({ endings: [ending], dropped: 0 })).toEqual({ endings: [ending], dropped: 0 })
    for (const bad of [
      null, 'text', { endings: [], dropped: 0 }, { endings: [ending] }, { endings: [ending], dropped: -1 },
      { endings: [{ ...ending, fate: { kind: 'completed' } }], dropped: 0 },
      { endings: [{ ...ending, fate: { kind: 'error' } }], dropped: 0 },
      { endings: [{ ...ending, memberName: '' }], dropped: 0 },
      { endings: [{ ...ending, did: 'everything' }], dropped: 0 },
      { endings: [{ ...ending, did: ['a', 'b', 'c', 'd', 'e', 'f'] }], dropped: 0 },
      { endings: Array.from({ length: FACTS_PER_NOTICE + 1 }, () => ending), dropped: 0 },
    ]) {
      expect(readTurnEndReport(bad)).toBeNull()
    }
  })

  it('cuts every free-text field to this machine\u2019s own bounds, whatever the sender cut', () => {
    const long = 'x'.repeat(5000)
    const read = readTurnEndReport({
      endings: [{
        memberName: long, fate: { kind: 'error', message: long }, did: [long],
        requestSummary: long, finalReply: long,
      }],
      dropped: 0,
    })!
    const [only] = read.endings
    expect(Array.from(only.requestSummary!)).toHaveLength(REQUEST_SUMMARY_LIMIT)
    expect(Array.from(only.finalReply!)).toHaveLength(FINAL_REPLY_LIMIT)
    expect(only.memberName.length).toBeLessThanOrEqual(120)
    expect(only.did![0].length).toBeLessThanOrEqual(160)
    expect(only.fate.kind === 'error' && only.fate.message.length).toBeLessThanOrEqual(501)
  })
})

describe('turn-end delivery recovery', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('stops timed retries after a bounded number, logging the outage once, and tries again with the next ending', async () => {
    const { bus, wakes } = makeBus()
    vi.mocked(bus.deliverRuntimeWake).mockRejectedValue(new Error('Could not reach the coordinating conversation (not_found)'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vi.mocked(bus.deliverRuntimeWake)).toHaveBeenCalledTimes(1 + MAX_TIMED_RETRIES)
    expect(errors.mock.calls.filter(([line]) => String(line).includes('could not reach the lead'))).toHaveLength(1)

    vi.mocked(bus.deliverRuntimeWake).mockImplementation(async (params: any) => {
      wakes.push({ toAppId: params.envelope.toAppId, body: params.envelope.body, kind: params.trigger.kind })
      return 'dispatched'
    })
    runTurn(report, 'app-editor', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(1)
    expect(lineFor(wakes[0].body, 'writer')).toContain('stopped with no error reported')
    expect(lineFor(wakes[0].body, 'editor')).toContain('stopped with no error reported')
    errors.mockRestore()
    report.clearEpoch(EPOCH)
  })

  it('retries a failed handoff without needing another ending, then clears its timer', async () => {
    const { bus, wakes } = makeBus()
    vi.mocked(bus.deliverRuntimeWake).mockRejectedValueOnce(new Error('mailbox temporarily full'))
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, 'app-writer', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(3000)
    expect(wakes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(wakes).toHaveLength(1)
    report.clearEpoch(EPOCH)
  })

  it('drops a failed handoff retry when the task closes', async () => {
    const { bus, wakes } = makeBus()
    vi.mocked(bus.deliverRuntimeWake).mockRejectedValueOnce(new Error('unavailable'))
    const store = makeStore(LOCAL_TEAM)
    const report = createTurnReport({ store, bus })
    runTurn(report, 'app-writer', [])
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(store.getEpochById).mockReturnValue({ id: EPOCH, endedAt: Date.now() } as any)
    await vi.advanceTimersByTimeAsync(3000)
    expect(wakes).toHaveLength(0)
    expect(vi.mocked(bus.deliverRuntimeWake)).toHaveBeenCalledTimes(1)
    report.clearEpoch(EPOCH)
  })
})
