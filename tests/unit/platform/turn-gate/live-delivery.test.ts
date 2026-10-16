import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTurnGate, type TurnGateHooks } from '../../../../src/main/platform/turn-gate'

type Job = { messages: string[]; identity?: string; key?: string }
const job = (text: string, identity?: string, key?: string): Job => ({ messages: [text], identity, key })

function fixture() {
  let busy = true
  let identity: string | undefined = 'owner'
  let accepts = true
  const starts: Job[] = []
  const live: Job[] = []
  const hooks: TurnGateHooks<Job> = {
    isBusy: () => busy,
    getActiveIdentity: () => identity,
    getJobIdentity: (message) => message.identity,
    mergeJobs: (jobs) => ({ ...jobs[0], messages: jobs.flatMap((entry) => entry.messages) }),
    dispatch: vi.fn(async (_key, message) => { starts.push(message); busy = true; identity = message.identity }),
    deliverMidTurn: vi.fn((_key, message) => { if (!accepts) return false; live.push(message); return true }),
  }
  const gate = createTurnGate(hooks, { getCoalescingKey: (message) => message.key, recheckMs: 100 })
  return { gate, hooks, starts, live, busy: (value: boolean) => { busy = value }, identity: (value?: string) => { identity = value }, accepts: (value: boolean) => { accepts = value } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('permission-aware delivery', () => {
  it('keeps guest and external work out of an owner turn and batches each group by first arrival', async () => {
    const f = fixture()
    await f.gate.deliver('chat', job('guest 1', 'guest:restricted'))
    await f.gate.deliver('chat', job('external 1', 'external'))
    await f.gate.deliver('chat', job('guest 2', 'guest:restricted'))
    expect(await f.gate.deliver('chat', job('owner correction', 'owner'))).toBe('mid_turn')
    expect(f.live[0].messages).toEqual(['owner correction'])
    f.busy(false)
    f.gate.drain('chat')
    await Promise.resolve()
    expect(f.starts[0].messages).toEqual(['guest 1', 'guest 2'])
    f.busy(false)
    f.gate.release('chat')
    f.gate.drain('chat')
    await Promise.resolve()
    expect(f.starts[1].messages).toEqual(['external 1'])
  })

  it('never treats unknown permissions as equal, including two unknowns', async () => {
    const f = fixture()
    f.identity(undefined)
    await f.gate.deliver('chat', job('unknown 1'))
    await f.gate.deliver('chat', job('unknown 2'))
    expect(f.live).toEqual([])
    f.busy(false)
    f.gate.drain('chat')
    expect(f.starts[0].messages).toEqual(['unknown 1'])
    expect(f.gate.bufferedCount('chat')).toBe(1)
  })

  it('flushes messages received during startup at the real readiness signal', async () => {
    const f = fixture()
    f.busy(false)
    f.hooks.dispatch = vi.fn(async (_key, message) => { f.starts.push(message) })
    await f.gate.deliver('chat', job('start', 'owner'))
    await f.gate.deliver('chat', job('early 1', 'owner'))
    await f.gate.deliver('chat', job('early 2', 'owner'))
    expect(f.live).toEqual([])
    f.busy(true)
    f.gate.notifyReady('chat')
    expect(f.live[0].messages).toEqual(['early 1', 'early 2'])
    expect(f.gate.hasBuffered('chat')).toBe(false)
  })

  it('retains a declined batch and starts it together immediately after turn end', async () => {
    const f = fixture()
    f.accepts(false)
    await f.gate.deliver('chat', job('one', 'owner'))
    await f.gate.deliver('chat', job('two', 'owner'))
    f.busy(false)
    f.gate.drain('chat')
    expect(f.starts[0].messages).toEqual(['one', 'two'])
    expect(f.live).toEqual([])
  })

  it('retains queued messages when starting their batch fails', async () => {
    const f = fixture()
    await f.gate.deliver('chat', job('one', 'external'))
    await f.gate.deliver('chat', job('two', 'external'))
    f.hooks.dispatch = vi.fn().mockRejectedValueOnce(new Error('temporary spawn failure')).mockImplementation(async (_key, message) => { f.starts.push(message); f.busy(true) })
    f.busy(false)
    f.gate.drain('chat')
    await vi.advanceTimersByTimeAsync(100)
    expect(f.starts[0].messages).toEqual(['one', 'two'])
  })

  it('settles permanently refused queued work without retrying a deleted target', async () => {
    let busy = true
    const dispatch = vi.fn().mockRejectedValue(new Error('target deleted'))
    const discarded = vi.fn()
    const gate = createTurnGate<Job>({ dispatch, isBusy: () => busy }, {
      retryDispatch: () => false, onDiscard: discarded, recheckMs: 100,
    })
    await gate.deliver('chat', job('message', 'owner'))
    busy = false
    gate.drain('chat')
    await vi.advanceTimersByTimeAsync(500)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(discarded).toHaveBeenCalledWith(job('message', 'owner'), 'target deleted')
    expect(gate.hasBuffered('chat')).toBe(false)
  })

  it('coalesces only within the same permission identity, retaining chronological order', async () => {
    const f = fixture()
    await f.gate.deliver('chat', job('old check', 'external', 'check'))
    await f.gate.deliver('chat', job('report', 'external'))
    await f.gate.deliver('chat', job('guest check', 'guest:x', 'check'))
    await f.gate.deliver('chat', job('new check', 'external', 'check'))
    expect(f.gate.bufferedCount('chat')).toBe(3)
    f.busy(false)
    f.gate.drain('chat')
    expect(f.starts[0].messages).toEqual(['report', 'new check'])
    expect(f.gate.bufferedCount('chat')).toBe(1)
  })

  it('offers durable spool context without queueing it when the target cannot accept', async () => {
    const f = fixture()
    expect(f.gate.tryDeliverLive('chat', job('guest context', 'guest:x'))).toBe(false)
    expect(f.gate.hasBuffered('chat')).toBe(false)
    f.accepts(false)
    await f.gate.deliver('chat', job('earlier owner input', 'owner'))
    f.accepts(true)
    expect(f.gate.tryDeliverLive('chat', job('owner context', 'owner'))).toBe(true)
    expect(f.live[0].messages).toEqual(['earlier owner input', 'owner context'])
    expect(f.gate.hasBuffered('chat')).toBe(false)
    f.busy(false)
    expect(f.gate.tryDeliverLive('chat', job('idle context', 'owner'))).toBe(false)
    expect(f.starts).toEqual([])
  })

  it('cancels only selected pending messages without disturbing other senders or the active slot', async () => {
    const f = fixture()
    f.accepts(false)
    await f.gate.deliver('chat', job('bot one', 'owner'))
    await f.gate.deliver('chat', job('bot two', 'owner'))
    expect(f.gate.discardJobs((_key, entry) => entry.messages[0] === 'bot one', 'bot disconnected')).toBe(1)
    expect(f.gate.isOccupied('chat')).toBe(true)
    f.accepts(true)
    f.gate.notifyReady('chat')
    expect(f.live[0].messages).toEqual(['bot two'])
  })

  it('revalidates queued identity in place without moving an older message behind its new group', async () => {
    const f = fixture()
    f.identity('external')
    let changed = false
    f.hooks.refreshJob = message => changed && message.messages[0] === 'earlier' ? { ...message, identity: 'guest:x' } : message
    await f.gate.deliver('chat', job('earlier', 'owner'))
    await f.gate.deliver('chat', job('later', 'guest:x'))
    changed = true
    f.busy(false)
    f.gate.drain('chat')
    expect(f.starts[0].messages).toEqual(['earlier', 'later'])
    expect(f.starts[0].identity).toBe('guest:x')
  })

  it('retains input when authority revalidation fails, instead of starting stale owner work', async () => {
    const f = fixture()
    f.identity('external')
    let fail = false
    f.hooks.refreshJob = message => { if (fail) throw new Error('configuration unavailable'); return message }
    await f.gate.deliver('chat', job('message', 'owner'))
    fail = true
    f.busy(false)
    f.gate.drain('chat')
    expect(f.starts).toEqual([])
    expect(f.gate.bufferedCount('chat')).toBe(1)
    fail = false
    await vi.advanceTimersByTimeAsync(100)
    expect(f.starts[0].messages).toEqual(['message'])
  })

  it('coalesces newest notices when refreshed identities converge', async () => {
    const f = fixture()
    f.identity('external')
    let changed = false
    f.hooks.refreshJob = message => changed ? { ...message, identity: 'guest:x' } : message
    await f.gate.deliver('chat', job('old reminder', 'owner', 'check'))
    await f.gate.deliver('chat', job('latest reminder', 'guest:x', 'check'))
    changed = true
    f.busy(false)
    f.gate.drain('chat')
    expect(f.starts[0].messages).toEqual(['latest reminder'])
  })

  it('does not resurrect a cancelled batch when its in-flight dispatch later rejects', async () => {
    let busy = true
    let rejectDispatch!: (error: Error) => void
    const dispatch = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectDispatch = reject }))
    const discarded = vi.fn()
    const gate = createTurnGate<Job>({ isBusy: () => busy, dispatch }, { onDiscard: discarded, recheckMs: 100 })
    await gate.deliver('chat', job('cancelled work', 'owner'))
    busy = false
    gate.drain('chat')
    expect(dispatch).toHaveBeenCalledOnce()
    gate.discard(() => true, 'task stopped')
    rejectDispatch(new Error('late startup failure'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(gate.hasBuffered('chat')).toBe(false)
    expect(gate.isOccupied('chat')).toBe(false)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(discarded).toHaveBeenCalledWith(job('cancelled work', 'owner'), 'task stopped')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves a newer startup reservation when the replaced dispatch rejects late', async () => {
    let rejectOld!: (error: Error) => void
    const dispatch = vi.fn((_key: string, entry: Job) => entry.messages[0] === 'old'
      ? new Promise<void>((_resolve, reject) => { rejectOld = reject }) : Promise.resolve())
    const gate = createTurnGate<Job>({ isBusy: () => false, dispatch })
    const old = gate.deliver('chat', job('old', 'owner'))
    const oldFailure = expect(old).rejects.toThrow('retired session')
    gate.discard(() => true, 'old session retired')
    await gate.deliver('chat', job('replacement', 'owner'))
    rejectOld(new Error('retired session'))
    await oldFailure
    expect(gate.isOccupied('chat')).toBe(true)
    expect(await gate.deliver('chat', job('third', 'owner'))).toBe('buffered')
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('retains bounded caller-provided identifiers in batch logs without logging message bodies', async () => {
    let busy = true
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const gate = createTurnGate<Job>({
        isBusy: () => busy, getJobIdentity: entry => entry.identity,
        dispatch: async () => {}, mergeJobs: entries => ({ ...entries[0], messages: entries.flatMap(entry => entry.messages) }),
      }, { describeJob: entry => `messageId=${entry.key}` })
      for (const key of ['id-one', 'id-two', 'id-three', 'id-four']) await gate.deliver('chat', job('private message body', 'owner', key))
      log.mockClear()
      busy = false
      gate.drain('chat')
      const line = String(log.mock.calls[0][0])
      expect(line).toContain('messageId=id-one,messageId=id-two,messageId=id-three,+1')
      expect(line).not.toContain('id-four')
      expect(line).not.toContain('private message body')
    } finally {
      log.mockRestore()
    }
  })

  it('never reorders a message across an exclusive callback' , async () => {
    const f = fixture()
    let finish!: () => void
    const exclusive = f.gate.runExclusive('chat', () => new Promise<void>((resolve) => { finish = resolve }))
    await f.gate.deliver('chat', job('after barrier', 'owner'))
    expect(f.live).toEqual([])
    f.busy(false)
    f.gate.drain('chat')
    expect(f.starts).toEqual([])
    finish()
    await exclusive
    expect(f.starts[0].messages).toEqual(['after barrier'])
  })

  it('does not let a new arrival bypass older queued work after the busy probe clears', async () => {
    const f = fixture()
    await f.gate.deliver('chat', job('earlier', 'external'))
    f.busy(false)
    await f.gate.deliver('chat', job('later', 'owner'))
    expect(f.starts[0].messages).toEqual(['earlier'])
    expect(f.gate.bufferedCount('chat')).toBe(1)
  })
})

describe('deliveries held after a person stops the work', () => {
  it('never joins the turn being stopped, and joins the next turn as it starts', async () => {
    const f = fixture()
    f.accepts(false)
    await f.gate.deliver('chat', job('report', 'owner'))
    f.gate.park('chat')
    f.gate.putBack('chat', [job('taken back', 'owner')])
    f.accepts(true)
    f.gate.drain('chat')
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.live).toEqual([])
    f.gate.notifyReady('chat')
    expect(f.live.map(entry => entry.messages)).toEqual([['taken back', 'report']])
  })

  it('keeps separate take-backs of one stop in their arrival order', async () => {
    const f = fixture()
    f.accepts(false)
    await f.gate.deliver('chat', job('waiting', 'owner'))
    f.gate.park('chat')
    f.gate.putBack('chat', [job('value is 100', 'owner')])
    f.gate.putBack('chat', [job('correction: 80', 'owner')])
    f.accepts(true)
    f.gate.notifyReady('chat')
    expect(f.live.map(entry => entry.messages)).toEqual([['value is 100', 'correction: 80', 'waiting']])
  })

  it('starts nothing on its own after the stopped turn ends', async () => {
    const f = fixture()
    f.accepts(false)
    await f.gate.deliver('chat', job('report', 'owner'))
    f.gate.park('chat')
    f.gate.putBack('chat', [job('taken back', 'owner')])
    f.busy(false)
    f.gate.release('chat')
    f.gate.drain('chat')
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.starts).toEqual([])
    expect(f.live).toEqual([])
    expect(f.gate.bufferedCount('chat')).toBe(2)

    await f.gate.deliver('chat', job('after the stop', 'owner'))
    expect(f.starts.map(entry => entry.messages)).toEqual([['taken back', 'report', 'after the stop']])
  })

  it('holds what is put back later even when nothing was waiting at the stop', async () => {
    const f = fixture()
    f.gate.park('chat')
    f.busy(false)
    f.gate.release('chat')
    f.gate.putBack('chat', [job('read too late', 'owner')])
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.starts).toEqual([])
    f.gate.notifyReady('chat')
    f.busy(false)
    f.gate.drain('chat')
    expect(f.starts.map(entry => entry.messages)).toEqual([['read too late']])
  })

  it('lets what is put back join the ordinary flow once a later arrival released the session', async () => {
    const f = fixture()
    f.accepts(false)
    f.gate.park('chat')
    // Arrives after the stop while the stopped turn is still winding down.
    await f.gate.deliver('chat', job('after the stop', 'owner'))
    f.busy(false)
    f.gate.release('chat')
    f.gate.putBack('chat', [job('taken back', 'owner')])
    expect(f.starts.map(entry => entry.messages)).toEqual([['taken back', 'after the stop']])
  })

  it('is released by a repeated restart attempt only if that attempt is actually taken', async () => {
    const f = fixture()
    f.accepts(false)
    await f.gate.deliver('chat', job('report', 'owner'))
    f.gate.park('chat')
    f.busy(false)
    expect(await f.gate.deliver('chat', job('scheduled', 'owner'), 'skip')).toBe('skipped')
    f.gate.drain('chat')
    expect(f.starts).toEqual([])
  })

  it('lets a job that may not open a turn wait for one while other work starts', async () => {
    let busy = false
    const starts: Job[] = []
    const gate = createTurnGate<Job>({
      isBusy: () => busy,
      getJobIdentity: (message) => message.identity,
      getActiveIdentity: () => 'owner',
      mergeJobs: (jobs) => ({ ...jobs[0], messages: jobs.flatMap((entry) => entry.messages) }),
      dispatch: async (_key, message) => { starts.push(message); busy = true },
      deliverMidTurn: () => false,
    }, { canOpenTurn: (message) => !message.messages.every(text => text.startsWith('recorded')) })
    gate.park('chat')
    gate.putBack('chat', [job('recorded report', 'owner')])
    await gate.deliver('chat', job('remote news', 'external'))
    expect(starts.map(entry => entry.messages)).toEqual([['remote news']])
    busy = false
    gate.release('chat')
    gate.drain('chat')
    expect(starts).toHaveLength(1)
    await gate.deliver('chat', job('owner note', 'owner'))
    expect(starts.map(entry => entry.messages)[1]).toEqual(['recorded report', 'owner note'])
  })
})
