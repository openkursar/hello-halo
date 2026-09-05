/**
 * Unit tests for the turn-end report.
 *
 * This is the only path that reaches a lead when nobody chose to speak, so what
 * is pinned here is mostly what it must NOT do: never claim a member finished
 * its work, never claim it filed nothing unless the whole turn was watched,
 * never wake the lead about the lead, never carry a word a member said, and —
 * the busy-gating tests at the bottom — never cut one busy stretch into several
 * independently-woken notices.
 *
 * Only the store and the bus are faked — the module imports neither Electron nor
 * the session layer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  createTurnReport,
  REPORT_WAKE_CAP,
  FLUSH_WINDOW_MS,
  LEAD_BUSY_RECHECK_MS,
  FACTS_PER_NOTICE,
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
    getTeamById: vi.fn(() => ({ id: TEAM, leadAppId: LEAD })),
    getEpochById: vi.fn(() => ({ id: EPOCH, endedAt: opts?.sealed ? Date.now() : null })),
    getMember: vi.fn((_teamId: string, appId: string) => members.find((m) => m.appId === appId) ?? null),
    getTaskById: vi.fn(() => ({ title: 'draft outline' })),
  } as unknown as TeamStore
}

function makeBus() {
  const wakes: { toAppId: string; body: string; kind?: string }[] = []
  const tripExternal = vi.fn()
  const bus = {
    deliverRuntimeWake: vi.fn(async (params: any) => {
      wakes.push({
        toAppId: params.envelope.toAppId,
        body: params.envelope.body,
        kind: params.trigger.kind,
      })
      return 'dispatched'
    }),
    tripExternal,
  } as unknown as MessageBus
  return { bus, wakes, tripExternal }
}

/**
 * Build a report wired the same way `createTeamRuntime` wires it in
 * production (`isLeadGenerating` sourced from the live "is this session
 * actively generating a turn" signal — see `TurnReportDeps`'s own doc for why
 * it is not `orchestration.isBusy`). Defaults to "always idle" here so every
 * existing test keeps exercising the idle-lead path it was written for; the
 * busy-gating tests pass their own `isLeadGenerating` to flip that.
 */
function makeReport(
  members: FakeMember[],
  bus: MessageBus,
  opts?: { sealed?: boolean; isLeadGenerating?: (sessionKey: string) => boolean }
): TurnReport {
  return createTurnReport({
    store: makeStore(members, opts),
    bus,
    isLeadGenerating: opts?.isLeadGenerating ?? (() => false),
  })
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
  report.noteTurnEnded(end ?? { appId, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
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
  let wakes: { toAppId: string; body: string; kind?: string }[]
  let tripExternal: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;({ bus, wakes, tripExternal } = makeBus())
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
    report.noteTurnEnded({ appId: 'app-editor', teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
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
    report.noteTurnEnded({
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

    // Not merely delayed: forcing a flush via the lead's own ending — the
    // exact trigger that surfaces anything sitting in the pending queue —
    // still produces nothing. If this ending had been queued (just held
    // back), this would have released it.
    report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(wakes).toHaveLength(0)
  })

  it("the lead's own ending never wakes the lead", async () => {
    const report = makeReport(LOCAL_TEAM, bus)
    runTurn(report, LEAD, [{ kind: 'message', targetAppId: 'app-writer' }])
    await new Promise((r) => setTimeout(r, 0))

    expect(wakes).toHaveLength(0)
  })

  it('endings that arrive while the lead is still reading merge into one later notice', async () => {
    const report = makeReport(LOCAL_TEAM, bus)

    runTurn(report, 'app-writer', [])
    await vi.waitFor(() => expect(wakes).toHaveLength(1))

    // The lead is now busy with that notice; two more stops must not each wake it.
    runTurn(report, 'app-editor', [])
    runTurn(report, 'app-writer', [])
    await new Promise((r) => setTimeout(r, 0))
    expect(wakes).toHaveLength(1)

    // Its turn ends → the ones that piled up go out together.
    report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await vi.waitFor(() => expect(wakes).toHaveLength(2))
    expect(wakes[1].body).toContain('editor')
    expect(wakes[1].body).toContain('writer')
  })

  it('a lead on another machine gets the same time-window coalescing as a local one', async () => {
    const remoteLead: FakeMember[] = [
      { appId: LEAD, memberName: 'Lead', origin: 'remote', ownerNodeId: 'node-b' },
      { appId: 'app-writer', memberName: 'writer' },
      { appId: 'app-editor', memberName: 'editor' },
    ]
    const report = makeReport(remoteLead, bus)

    runTurn(report, 'app-writer', [])
    await vi.waitFor(() => expect(wakes).toHaveLength(1))

    // Arriving moments later, this merges into the next notice instead of
    // waking the lead again immediately — remoteness no longer matters: the
    // old "does the lead ever tell us it read one" signal (which a remote
    // lead could never send) is gone, replaced by the same time window a
    // local lead gets.
    runTurn(report, 'app-editor', [])
    await new Promise((r) => setTimeout(r, 0))
    expect(wakes).toHaveLength(1)

    report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await vi.waitFor(() => expect(wakes).toHaveLength(2))
    expect(wakes[1].body).toContain('editor')
  })

  it('the machine that did not run the turn stays quiet about how it ended', async () => {
    const remoteMember: FakeMember[] = [
      { appId: LEAD, memberName: 'Lead' },
      { appId: 'app-writer', memberName: 'writer', origin: 'remote', ownerNodeId: 'node-b' },
    ]
    const report = makeReport(remoteMember, bus)

    // Its owner witnessed this and reports it there; a second notice here would
    // announce the same ending twice.
    report.noteTurnEnded({ appId: 'app-writer', teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(wakes).toHaveLength(0)

    // Nothing ran anywhere, so the waiting side is the only witness there is.
    report.noteTurnEnded({
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
    report.noteTurnEnded({ ...ending, fate: { kind: 'timeout' } })
    report.noteTurnEnded({ ...ending, fate: { kind: 'error', message: 'aborted' } })
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
    report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })

    // A second turn that does nothing must not inherit the first turn's
    // message — the real delay matters here (not just event ordering): both
    // turns' timestamps must land in different milliseconds for act
    // attribution (`a.at >= since`) to tell them apart at all.
    await new Promise((r) => setTimeout(r, 2))
    runTurn(report, 'app-writer', [])
    // Force this ending's notice out now instead of waiting on the real
    // coalescing window — the lead's own turn ending already does exactly
    // this in production (see "endings that arrive while the lead is still
    // reading merge into one later notice").
    report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await vi.waitFor(() => expect(wakes).toHaveLength(2))
    expect(lineFor(wakes[1].body, 'writer')).toContain('filed nothing during that turn')
  })

  it(
    'trips the independent report-wake cap via the same breach channel message-volume limits use, ' +
      'without ever touching the message-volume counter itself',
    async () => {
      const report = makeReport(LOCAL_TEAM, bus)

      // REPORT_WAKE_CAP wakes, each forced out via the lead's-own-ending
      // shortcut so every one of them actually goes out as its own wake
      // instead of coalescing into fewer attempts. Looped synchronously
      // (no per-iteration await) since each call's synchronous prefix
      // (clear timer, delete pending, set lastFlushAt) fully runs before the
      // next iteration starts — only the final state needs waiting for.
      for (let i = 0; i < REPORT_WAKE_CAP; i++) {
        runTurn(report, 'app-writer', [])
        report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
      }
      await vi.waitFor(() => expect(wakes).toHaveLength(REPORT_WAKE_CAP))
      expect(tripExternal).not.toHaveBeenCalled()

      // One more crosses it. Wait on tripExternal itself, not just wakes'
      // length: the mock pushes to `wakes` before `deliverRuntimeWake`
      // resolves, which is before flush()'s own continuation (the counter
      // bump + tripExternal call) runs — waiting on wakes alone would race
      // ahead of that continuation.
      runTurn(report, 'app-writer', [])
      report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
      await vi.waitFor(() => expect(tripExternal).toHaveBeenCalled())
      expect(tripExternal).toHaveBeenCalledWith(TEAM, EPOCH, 'turnReportFlood')
    }
  )
})

/**
 * The time-window mechanism itself, under fake timers. The tests above prove
 * coalescing using the lead's-own-ending shortcut (a real, production early-
 * flush trigger), but none of them let `FLUSH_WINDOW_MS` actually elapse —
 * so none of them prove the trailing timer really fires on its own. That is
 * the core of this fix (replacing `outstanding`/`leadIsLocal`, which never
 * merged anything for a remote lead) and needs its own proof, including the
 * remote-lead case explicitly.
 */
describe('turn-end report — time-window coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('an isolated ending flushes immediately; one arriving inside the window waits, then auto-flushes once the window elapses', async () => {
    const { bus, wakes } = makeBus()
    const report = makeReport(LOCAL_TEAM, bus)

    runTurn(report, 'app-writer', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(1)

    // Arrives well inside the window — must not wake again yet.
    runTurn(report, 'app-editor', [])
    await vi.advanceTimersByTimeAsync(FLUSH_WINDOW_MS - 1)
    expect(wakes).toHaveLength(1)

    // The window elapses — the trailing timer fires ON ITS OWN, no lead
    // action needed.
    await vi.advanceTimersByTimeAsync(1)
    expect(wakes).toHaveLength(2)
    expect(wakes[1].body).toContain('editor')
  })

  it("the lead's own ending flushes immediately even mid-window, and cancels the trailing timer so it does not ALSO fire later", async () => {
    const { bus, wakes } = makeBus()
    const report = makeReport(LOCAL_TEAM, bus)

    runTurn(report, 'app-writer', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(1)

    runTurn(report, 'app-editor', [])
    await vi.advanceTimersByTimeAsync(1) // still well inside the window
    expect(wakes).toHaveLength(1)

    report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(2)
    expect(wakes[1].body).toContain('editor')

    // The trailing timer that would have fired later must have been
    // cancelled — advancing past where it would have fired must not
    // produce a third, empty wake.
    await vi.advanceTimersByTimeAsync(FLUSH_WINDOW_MS)
    expect(wakes).toHaveLength(2)
  })

  it('a lead on another machine gets exactly the same window-based coalescing and auto-flush as a local one', async () => {
    const { bus, wakes } = makeBus()
    const remoteLead: FakeMember[] = [
      { appId: LEAD, memberName: 'Lead', origin: 'remote', ownerNodeId: 'node-b' },
      { appId: 'app-writer', memberName: 'writer' },
      { appId: 'app-editor', memberName: 'editor' },
    ]
    const report = makeReport(remoteLead, bus)

    runTurn(report, 'app-writer', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(1)

    // Arriving moments later, this merges into the next notice instead of
    // waking the lead again immediately — remoteness no longer matters: the
    // old "does the lead ever tell us it read one" signal (which a remote
    // lead could never send, so it never merged anything cross-machine) is
    // gone, replaced by the exact same time window a local lead gets.
    runTurn(report, 'app-editor', [])
    await vi.advanceTimersByTimeAsync(FLUSH_WINDOW_MS - 1)
    expect(wakes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(wakes).toHaveLength(2)
    expect(wakes[1].body).toContain('editor')
  })

  it(
    'a healthy team sustained at the maximum rate the window allows, for a long-running epoch, ' +
      'never trips the report-wake cap — a fixed backstop, not a second rate limiter',
    async () => {
      const { bus, tripExternal } = makeBus()
      const report = makeReport(LOCAL_TEAM, bus)

      // REPORT_WAKE_CAP is a fixed backstop, well above what any healthy
      // long run generates at one wake every FLUSH_WINDOW_MS.
      const healthyWakesForFullEpoch = REPORT_WAKE_CAP / 2
      for (let i = 0; i < healthyWakesForFullEpoch; i++) {
        runTurn(report, 'app-writer', [])
        await vi.advanceTimersByTimeAsync(FLUSH_WINDOW_MS)
      }

      expect(tripExternal).not.toHaveBeenCalled()
    }
  )
})

/**
 * The busy-gating fix itself: a lead that stays busy for a long stretch must
 * not be woken by the flush window ticking on its own — only its own turn
 * ending may flush a busy stretch, and it must do so exactly once, carrying
 * everything that piled up. Before this fix, `requestFlush` fired on elapsed
 * time alone: several endings spread across one long busy stretch each
 * queued their own buffered turn, and the lead surfaced from one only to find
 * the next already queued behind it — the screenful of independent
 * "nothing to do" replies this fix removes.
 *
 * `isLeadGenerating` here is a fake the test controls directly (see
 * `TurnReportDeps.isLeadGenerating` for what it is in production and why).
 * The production wiring itself cannot be exercised by a unit test; it was
 * verified by reading the call chain from `bootstrap/extended.ts` through to
 * `app-chat.ts`, not by a test in this file.
 */
describe('turn-end report — busy-lead gating', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a lead busy for longer than several flush windows is not woken by the window itself', async () => {
    const { bus, wakes } = makeBus()
    let busy = true
    const report = makeReport(LOCAL_TEAM, bus, { isLeadGenerating: () => busy })

    // Four endings, one per window, while the lead stays busy throughout —
    // the buggy version fired a separate buffered flush for each of these.
    for (let i = 0; i < 4; i++) {
      runTurn(report, i % 2 === 0 ? 'app-writer' : 'app-editor', [])
      await vi.advanceTimersByTimeAsync(FLUSH_WINDOW_MS)
    }
    expect(wakes).toHaveLength(0)

    // The lead frees up and its own turn ends — everything that piled up
    // during the whole busy stretch goes out as exactly ONE notice.
    busy = false
    report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(1)
    expect(wakes[0].body).toContain('writer')
    expect(wakes[0].body).toContain('editor')
  })

  it('a trailing timer scheduled while idle defers to the lead-ending flush if the lead turns busy before it fires', async () => {
    const { bus, wakes } = makeBus()
    let busy = false
    const report = makeReport(LOCAL_TEAM, bus, { isLeadGenerating: () => busy })

    // Isolated ending while idle: flushes immediately, same as ever.
    runTurn(report, 'app-writer', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(1)

    // A second ending lands inside the window (still idle) and schedules the
    // trailing timer as usual.
    runTurn(report, 'app-editor', [])
    await vi.advanceTimersByTimeAsync(1)
    expect(wakes).toHaveLength(1)

    // The lead becomes busy with something unrelated (e.g. its own person
    // starts a chat) before the trailing timer fires.
    busy = true
    await vi.advanceTimersByTimeAsync(FLUSH_WINDOW_MS)
    // The timer fired, saw the lead busy, and deferred to the busy-backstop
    // path instead of flushing — no second wake yet.
    expect(wakes).toHaveLength(1)

    // The lead's own turn ends — that flushes the pending "editor" ending.
    busy = false
    report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(2)
    expect(wakes[1].body).toContain('editor')
  })

  it('a member ending while the lead is busy does not itself flush — it only arms the busy-backstop recheck, which keeps re-arming while busy stays true', async () => {
    const { bus, wakes } = makeBus()
    const report = makeReport(LOCAL_TEAM, bus, { isLeadGenerating: () => true })

    runTurn(report, 'app-writer', [])
    // Advance past several backstop periods — each recheck must see "still
    // busy" and re-arm rather than flush into a bus mock that always resolves
    // as 'dispatched' regardless of real busyness.
    await vi.advanceTimersByTimeAsync(LEAD_BUSY_RECHECK_MS * 3)
    expect(wakes).toHaveLength(0)
  })

  it('the busy-backstop recheck eventually flushes on its own once the busy reading clears, even without a lead-own-ending signal ever arriving', async () => {
    const { bus, wakes } = makeBus()
    let busy = true
    const report = makeReport(LOCAL_TEAM, bus, { isLeadGenerating: () => busy })

    runTurn(report, 'app-writer', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(0)

    // The busy reading clears on its own — this is the safety net for a
    // signal that resolved late (or was ever plain wrong), not the primary
    // path: nothing here calls `noteTurnEnded` for the lead itself.
    busy = false
    await vi.advanceTimersByTimeAsync(LEAD_BUSY_RECHECK_MS)
    expect(wakes).toHaveLength(1)
    expect(wakes[0].body).toContain('writer')
  })

  it("a member's ending and the lead's own ending landing in the same busy stretch do not lose the member's ending", async () => {
    const { bus, wakes } = makeBus()
    let busy = true
    const report = makeReport(LOCAL_TEAM, bus, { isLeadGenerating: () => busy })

    // The member's turn ends while the lead is still busy — piles into
    // pending, no flush yet.
    runTurn(report, 'app-writer', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(wakes).toHaveLength(0)

    // The lead's own turn ends moments later, in the same busy stretch.
    busy = false
    report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await vi.advanceTimersByTimeAsync(0)

    expect(wakes).toHaveLength(1)
    expect(wakes[0].body).toContain('writer')
  })

  it('endings beyond FACTS_PER_NOTICE piling up during a busy stretch are dropped from the front, but counted in the eventual notice', async () => {
    const { bus, wakes } = makeBus()
    let busy = true
    const report = makeReport(LOCAL_TEAM, bus, { isLeadGenerating: () => busy })

    // Two more than the cap — the two oldest are dropped, not silently lost.
    for (let i = 0; i < FACTS_PER_NOTICE + 2; i++) {
      runTurn(report, i % 2 === 0 ? 'app-writer' : 'app-editor', [])
    }
    expect(wakes).toHaveLength(0)

    busy = false
    report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await vi.advanceTimersByTimeAsync(0)

    expect(wakes).toHaveLength(1)
    expect(wakes[0].body).toContain('2 earlier endings piled up')
  })
})

/**
 * A delivery failure puts the batch back in `pending` for the next attempt —
 * but endings that land WHILE that failed attempt is in flight merge into the
 * put-back batch too, and that merge can itself cross `FACTS_PER_NOTICE`. The
 * overflow from that merge must be counted the same way the normal
 * accumulation path counts it, or a delivery failure becomes the one silent
 * way to lose an ending — the exact failure this whole module exists to
 * prevent, on the one path most likely to be hit under real network trouble.
 */
describe('turn-end report — delivery-failure accounting', () => {
  it('endings that pile up during a failed delivery attempt are counted in the retry, not lost', async () => {
    let report: TurnReport
    let deliverCalls = 0
    let busy = false
    const wakes: { body: string }[] = []
    const bus = {
      deliverRuntimeWake: vi.fn(async (params: any) => {
        deliverCalls += 1
        if (deliverCalls === 1) {
          // Mark the lead busy for the duration of this injection so the
          // extra endings below only accumulate (no timer, no second flush)
          // — mirroring "something else landed while this attempt was on
          // the wire", without needing to race real timers to prove it.
          busy = true
          for (let i = 0; i < FACTS_PER_NOTICE; i++) {
            report.noteTurnEnded({ appId: 'app-editor', teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
          }
          busy = false
          throw new Error('network blip')
        }
        wakes.push({ body: params.envelope.body })
        return 'dispatched'
      }),
      tripExternal: vi.fn(),
    } as unknown as MessageBus

    report = createTurnReport({ store: makeStore(LOCAL_TEAM), bus, isLeadGenerating: () => busy })

    // The one writer ending in `facts`, plus the FACTS_PER_NOTICE editor
    // endings injected during the failed attempt, merge to one over the cap.
    runTurn(report, 'app-writer', [])
    await vi.waitFor(() => expect(deliverCalls).toBe(1))
    await new Promise((r) => setTimeout(r, 0)) // let flush()'s catch block finish running

    // Force the retry via the lead's own ending, same as every other test here.
    report.noteTurnEnded({ appId: LEAD, teamId: TEAM, epochId: EPOCH, fate: { kind: 'ended' } })
    await vi.waitFor(() => expect(wakes).toHaveLength(1))

    expect(wakes[0].body).toContain('1 earlier ending piled up')
  })
})
