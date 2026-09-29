/**
 * The module's rules over more than one conversation source: registry, merged
 * listing and reading, reference resolution, delivery routing, capability
 * gating, and turn-end wiring. The sources here are in-memory fakes; the
 * module's own state (turn gate, waits, rate windows, registry) is reloaded for
 * every test.
 *
 * `dh` stands for any source owned by a higher tier (ids `app-chat:*`); `notes`
 * is a second one with a different id space. The built-in space source that
 * `initConversationInterop` adds claims only ids outside `app-chat:*`, so `notes`
 * is registered first to win its own ids — the registry is first-owner-wins.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ConversationSource, DispatchedMessage } from '../../../../src/main/services/conversation-interop/source'
import type { TranscriptLine } from '../../../../src/main/services/conversation-interop/types'

vi.mock('../../../../src/main/services/agent/events', () => ({ onAgentEvent: () => ({ dispose: () => undefined }) }))
vi.mock('../../../../src/main/services/conversation.service', () => ({
  getConversation: () => null,
  listConversations: () => [],
}))
vi.mock('../../../../src/main/services/agent/send-message', () => ({ sendMessage: vi.fn() }))

// chat-source reaches the engine through the services/agent barrel; without this
// every module reset would load the whole engine graph.
vi.mock('../../../../src/main/services/agent', async () => ({
  onAgentEvent: (await import('../../../../src/main/services/agent/events')).onAgentEvent,
  sendMessage: (await import('../../../../src/main/services/agent/send-message')).sendMessage,
}))
vi.mock('../../../../src/main/services/conversation-interop/busy', () => ({
  isNativeConversationBusy: () => false,
  hasLiveNativeSession: () => false,
}))

interface FakeConv {
  id: string
  title: string
  updatedAt: string
  lines: TranscriptLine[]
  unavailable?: string
}

interface FakeSourceOptions {
  kind: string
  prefix: string
  label?: string
  readable?: boolean
  writable?: boolean
  whyNotWritable?: string
  shortRef?: (id: string) => string
}

function createFakeSource(options: FakeSourceOptions) {
  const conversations = new Map<string, FakeConv>()
  const busy = new Set<string>()
  const live = new Set<string>()
  const notices: { id: string; content: string }[] = []
  const dispatched: { id: string; message: DispatchedMessage }[] = []
  let turnEndListener: ((id: string) => void) | null = null
  let dispatchImpl: (id: string, message: DispatchedMessage) => Promise<{ messageId?: string }> = async (id) => {
    busy.add(id)
    live.add(id)
    return { messageId: `${id}#msg` }
  }

  const meta = (c: FakeConv) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt,
    messageCount: c.lines.length,
    ...(c.unavailable ? { unavailable: c.unavailable } : {}),
  })

  const source: ConversationSource = {
    kind: options.kind,
    ...(options.label ? { label: options.label } : {}),
    capabilities: { readable: options.readable ?? true, writable: options.writable ?? true },
    ...(options.whyNotWritable ? { whyNotWritable: options.whyNotWritable } : {}),
    owns: (id) => id.startsWith(options.prefix),
    list: () => [...conversations.values()].map(meta),
    getMeta: (_space, id) => {
      const c = conversations.get(id)
      return c ? meta(c) : null
    },
    shortRef: options.shortRef ?? ((id) => id.slice(options.prefix.length, options.prefix.length + 8).padEnd(8, '0')),
    readTranscript: (_space, id) => conversations.get(id)?.lines ?? null,
    isBusy: (id) => busy.has(id),
    hasLiveSession: (id) => live.has(id),
    dispatch: async (_space, id, message) => {
      dispatched.push({ id, message })
      return dispatchImpl(id, message)
    },
    onTurnEnd: (listener) => {
      turnEndListener = listener
      return { dispose: () => { turnEndListener = null } }
    },
    writeNotice: (_space, id, content) => { notices.push({ id, content }) },
  }

  return {
    source,
    busy,
    live,
    notices,
    dispatched,
    seed(id: string, title: string, updatedAt: string, lines: TranscriptLine[] = [], unavailable?: string) {
      conversations.set(id, { id, title, updatedAt, lines, ...(unavailable ? { unavailable } : {}) })
    },
    setUnavailable(id: string, reason: string | undefined) {
      const c = conversations.get(id)
      if (!c) return
      if (reason) c.unavailable = reason
      else delete c.unavailable
    },
    endTurn(id: string) {
      busy.delete(id)
      turnEndListener?.(id)
    },
    setDispatch(fn: typeof dispatchImpl) { dispatchImpl = fn },
  }
}

type Fake = ReturnType<typeof createFakeSource>

let sourceModule: typeof import('../../../../src/main/services/conversation-interop/source')
let listRead: typeof import('../../../../src/main/services/conversation-interop/list-read')
let resolution: typeof import('../../../../src/main/services/conversation-interop/target-resolution')
let delivery: typeof import('../../../../src/main/services/conversation-interop/delivery')
let lifecycle: typeof import('../../../../src/main/services/conversation-interop/lifecycle')

let dh: Fake
let notes: Fake

const SPACE = 'space-1'
const line = (role: TranscriptLine['role'], content: string): TranscriptLine => ({ role, content, timestamp: '2026-01-01T00:00:00.000Z' })
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  sourceModule = await import('../../../../src/main/services/conversation-interop/source')
  listRead = await import('../../../../src/main/services/conversation-interop/list-read')
  resolution = await import('../../../../src/main/services/conversation-interop/target-resolution')
  delivery = await import('../../../../src/main/services/conversation-interop/delivery')
  lifecycle = await import('../../../../src/main/services/conversation-interop/lifecycle')

  notes = createFakeSource({ kind: 'notes', prefix: 'notes:' })
  dh = createFakeSource({ kind: 'digital-human', prefix: 'app-chat:', label: 'digital human' })
  sourceModule.registerConversationSource(notes.source)
  sourceModule.registerConversationSource(dh.source)
})

afterEach(() => {
  lifecycle.disposeConversationInterop()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('registry', () => {
  it('routes an id to the source that owns it, and to none when nothing does', () => {
    expect(sourceModule.sourceOfConversation('app-chat:app-1')).toBe(dh.source)
    expect(sourceModule.sourceOfConversation('notes:1')).toBe(notes.source)
    expect(sourceModule.sourceOfConversation('elsewhere:1')).toBeNull()
  })

  it('replaces a source of the same kind, and a stale registration cannot remove its replacement', () => {
    const replacement = createFakeSource({ kind: 'digital-human', prefix: 'app-chat:' })
    const registration = sourceModule.registerConversationSource(dh.source)
    sourceModule.registerConversationSource(replacement.source)
    expect(sourceModule.sourceOfConversation('app-chat:x')).toBe(replacement.source)

    registration.dispose()
    expect(sourceModule.sourceOfConversation('app-chat:x')).toBe(replacement.source)
  })

  it('stops routing to a source once its registration is disposed', () => {
    const registration = sourceModule.registerConversationSource(dh.source)
    registration.dispose()
    expect(sourceModule.sourceOfConversation('app-chat:x')).toBeNull()
  })

  it('lists only readable sources as readable', () => {
    const hidden = createFakeSource({ kind: 'hidden', prefix: 'hidden:', readable: false })
    sourceModule.registerConversationSource(hidden.source)
    expect(sourceModule.getReadableSources().map((s) => s.kind)).toEqual(['notes', 'digital-human'])
  })
})

describe('listing and reading across sources', () => {
  beforeEach(() => {
    notes.seed('notes:a', 'Old notes', '2026-01-01T00:00:00.000Z')
    notes.seed('notes:b', 'Fresh notes', '2026-01-03T00:00:00.000Z')
    dh.seed('app-chat:app-1', 'Analyst', '2026-01-02T00:00:00.000Z', [line('user', 'hi'), line('assistant', 'hello')])
  })

  it('merges every readable source into one recency-ordered list, labelling the qualified ones', () => {
    const result = listRead.listConversationsForInterop(SPACE, 'caller')
    if (!result.ok) throw new Error('expected ok')
    expect(result.page.items.map((i) => [i.id, i.label])).toEqual([
      ['notes:b', undefined],
      ['app-chat:app-1', 'digital human'],
      ['notes:a', undefined],
    ])
    expect(result.page.total).toBe(3)
  })

  it('reads the running state from the owning source', () => {
    dh.busy.add('app-chat:app-1')
    const result = listRead.listConversationsForInterop(SPACE, 'caller')
    if (!result.ok) throw new Error('expected ok')
    expect(result.page.items.map((i) => [i.id, i.running])).toEqual([
      ['notes:b', false],
      ['app-chat:app-1', true],
      ['notes:a', false],
    ])
  })

  it('keeps listing and resolving the other sources when one fails to list', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    dh.source.list = () => { throw new Error('registry unavailable') }

    const result = listRead.listConversationsForInterop(SPACE, 'caller')
    if (!result.ok) throw new Error('expected ok')
    expect(result.page.items.map((i) => i.id)).toEqual(['notes:b', 'notes:a'])
    expect(resolution.resolveConversationTarget(SPACE, 'caller', 'Fresh notes')).toEqual({ ok: true, conversationId: 'notes:b' })
    expect(error).toHaveBeenCalledWith(expect.stringContaining('digital-human failed to list'), expect.any(Error))
    error.mockRestore()
  })

  it('leaves the caller out of the list, whichever source it belongs to', () => {
    const result = listRead.listConversationsForInterop(SPACE, 'app-chat:app-1')
    if (!result.ok) throw new Error('expected ok')
    expect(result.page.items.map((i) => i.id)).toEqual(['notes:b', 'notes:a'])
  })

  it('omits a source that is not readable, and refuses to read its conversations', () => {
    const hidden = createFakeSource({ kind: 'hidden', prefix: 'hidden:', readable: false })
    hidden.seed('hidden:1', 'Secret', '2026-01-04T00:00:00.000Z', [line('user', 'x')])
    sourceModule.registerConversationSource(hidden.source)

    const list = listRead.listConversationsForInterop(SPACE, 'caller')
    if (!list.ok) throw new Error('expected ok')
    expect(list.page.items.map((i) => i.id)).not.toContain('hidden:1')
    expect(listRead.readConversationForInterop(SPACE, 'hidden:1')).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('reads a conversation of another source with the module\'s own paging, carrying the source label', () => {
    const result = listRead.readConversationForInterop(SPACE, 'app-chat:app-1', undefined, 2)
    if (!result.ok) throw new Error('expected ok')
    expect(result.page).toMatchObject({
      id: 'app-chat:app-1',
      title: 'Analyst',
      label: 'digital human',
      totalMessages: 2,
      hiddenBefore: 1,
      nextCursor: '1',
    })
    expect(result.page.lines.map((l) => l.content)).toEqual(['hello'])

    const older = listRead.readConversationForInterop(SPACE, 'app-chat:app-1', '1', 2)
    if (!older.ok) throw new Error('expected ok')
    expect(older.page.lines.map((l) => l.content)).toEqual(['hi'])
    expect(older.page.hiddenBefore).toBe(0)
  })

  it('reports not_found for an id no source knows, and for an unknown id inside a known source', () => {
    expect(listRead.readConversationForInterop(SPACE, 'elsewhere:1')).toEqual({ ok: false, reason: 'not_found' })
    expect(listRead.readConversationForInterop(SPACE, 'app-chat:missing')).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('reference resolution across sources', () => {
  it('resolves an exact id in any source', () => {
    dh.seed('app-chat:app-1', 'Analyst', '2026-01-02T00:00:00.000Z')
    expect(resolution.resolveConversationTarget(SPACE, 'caller', 'app-chat:app-1')).toEqual({ ok: true, conversationId: 'app-chat:app-1' })
  })

  it('resolves a short handle using the owning source\'s own derivation', () => {
    const hashed = createFakeSource({ kind: 'hashed', prefix: 'hashed:', shortRef: () => 'deadbeef' })
    hashed.seed('hashed:one', 'Some conversation', '2026-01-02T00:00:00.000Z')
    sourceModule.registerConversationSource(hashed.source)

    expect(resolution.resolveConversationTarget(SPACE, 'caller', 'DEADBEEF')).toEqual({ ok: true, conversationId: 'hashed:one' })
    expect(resolution.resolveConversationTarget(SPACE, 'caller', 'conv:deadbeef')).toEqual({ ok: true, conversationId: 'hashed:one' })
  })

  it('treats a short handle two sources both produce as ambiguous, most recent first', () => {
    const a = createFakeSource({ kind: 'a', prefix: 'a:', shortRef: () => 'abcd1234' })
    const b = createFakeSource({ kind: 'b', prefix: 'b:', shortRef: () => 'abcd1234' })
    a.seed('a:1', 'First', '2026-01-01T00:00:00.000Z')
    b.seed('b:1', 'Second', '2026-01-05T00:00:00.000Z')
    sourceModule.registerConversationSource(a.source)
    sourceModule.registerConversationSource(b.source)

    expect(resolution.resolveConversationTarget(SPACE, 'caller', 'abcd1234')).toEqual({
      ok: false,
      reason: 'ambiguous_short_id',
      candidates: [
        { id: 'b:1', updatedAt: '2026-01-05T00:00:00.000Z' },
        { id: 'a:1', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    })
  })

  it('treats a title shared between sources as ambiguous, and skips the caller\'s own conversation', () => {
    notes.seed('notes:1', 'Weekly sync', '2026-01-01T00:00:00.000Z')
    dh.seed('app-chat:app-1', 'Weekly sync', '2026-01-02T00:00:00.000Z')

    expect(resolution.resolveConversationTarget(SPACE, 'caller', 'weekly sync')).toMatchObject({ ok: false, reason: 'ambiguous_title' })
    expect(resolution.resolveConversationTarget(SPACE, 'app-chat:app-1', 'Weekly sync')).toEqual({ ok: true, conversationId: 'notes:1' })
  })

  it('reports self_target_title when the only titled match is the caller itself', () => {
    dh.seed('app-chat:app-1', 'Only me', '2026-01-02T00:00:00.000Z')
    expect(resolution.resolveConversationTarget(SPACE, 'app-chat:app-1', 'Only me')).toEqual({ ok: false, reason: 'self_target_title' })
  })
})

describe('withheld conversations', () => {
  function withheldSource() {
    const fake = createFakeSource({ kind: 'withheld', prefix: 'withheld:', shortRef: () => 'feedf00d' })
    fake.seed('withheld:1', 'Secret plan', '2026-01-01T00:00:00.000Z', [line('user', 'x')], 'switched off')
    sourceModule.registerConversationSource(fake.source)
    return fake
  }

  it('answers a reference by id, short handle or title with the source\'s reason', () => {
    withheldSource()
    for (const target of ['withheld:1', 'feedf00d', 'secret plan']) {
      expect(resolution.resolveConversationTarget(SPACE, 'caller', target), target).toMatchObject({
        ok: false, reason: 'unavailable', conversationId: 'withheld:1', detail: 'switched off',
      })
    }
  })

  it('lets a reachable conversation with the same title win', () => {
    withheldSource()
    notes.seed('notes:9', 'Secret plan', '2026-01-01T00:00:00.000Z')
    expect(resolution.resolveConversationTarget(SPACE, 'caller', 'Secret plan')).toEqual({ ok: true, conversationId: 'notes:9' })
  })

  it('keeps resolving when a source fails to list', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fake = withheldSource()
    fake.source.list = () => { throw new Error('boom') }
    expect(resolution.resolveConversationTarget(SPACE, 'caller', 'Secret plan')).toEqual({ ok: false, reason: 'not_found' })
    error.mockRestore()
  })

  it('does not list or read a withheld conversation, and says why when asked to read it', () => {
    withheldSource()
    const list = listRead.listConversationsForInterop(SPACE, 'caller')
    if (!list.ok) throw new Error('expected ok')
    expect(list.page.items.map((i) => i.id)).not.toContain('withheld:1')
    expect(listRead.readConversationForInterop(SPACE, 'withheld:1')).toEqual({ ok: false, reason: 'unavailable', detail: 'switched off' })
  })
})

describe('delivery across sources', () => {
  const send = (from: string, to: string, message = 'hello') =>
    delivery.deliverToConversation({ spaceId: SPACE, fromConversationId: from, toConversationId: to, message, summary: 'sum' })

  let archive: Fake

  beforeEach(() => {
    notes.seed('notes:1', 'Notes thread', '2026-01-01T00:00:00.000Z')
    dh.seed('app-chat:app-1', 'Analyst', '2026-01-02T00:00:00.000Z')
    archive = createFakeSource({ kind: 'archive', prefix: 'archive:', writable: false })
    archive.seed('archive:1', 'Archive', '2026-01-01T00:00:00.000Z')
    sourceModule.registerConversationSource(archive.source)
    lifecycle.initConversationInterop()
  })

  it('hands the recipient\'s source the framed turn input and the record its transcript keeps', async () => {
    const result = await send('notes:1', 'app-chat:app-1', 'the exact words')

    expect(result).toEqual({ ok: true, status: 'delivered', messageId: 'app-chat:app-1#msg' })
    expect(notes.dispatched).toHaveLength(0)
    expect(dh.dispatched).toHaveLength(1)
    const { turnInput, record } = dh.dispatched[0].message
    expect(turnInput).toContain('the exact words')
    expect(turnInput).toContain('Notes thread')
    expect(turnInput).toContain('not from your user')
    expect(record).toEqual({
      content: 'the exact words',
      source: 'cross-conversation',
      metadata: { fromConversationId: 'notes:1', fromConversationTitle: 'Notes thread', summary: 'sum', forwardDepth: 0 },
    })
  })

  it('names the sender from whichever source it lives in', async () => {
    await send('app-chat:app-1', 'notes:1')
    expect(notes.dispatched[0].message.record.metadata).toMatchObject({ fromConversationTitle: 'Analyst' })
  })

  it('reports a source that could not name the message as delivered with no id', async () => {
    dh.setDispatch(async () => ({}))
    expect(await send('notes:1', 'app-chat:app-1')).toEqual({ ok: true, status: 'delivered', messageId: '' })
  })

  it('queues behind a turn the recipient\'s source reports as running, then dispatches when that source reports the turn ended', async () => {
    dh.busy.add('app-chat:app-1')
    expect(await send('notes:1', 'app-chat:app-1', 'later')).toEqual({ ok: true, status: 'queued' })
    expect(dh.dispatched).toHaveLength(0)

    dh.endTurn('app-chat:app-1')
    await flush()

    expect(dh.dispatched).toHaveLength(1)
    expect(dh.dispatched[0].message.record.content).toBe('later')
  })

  it('maps a source that fails to start the turn to unreachable', async () => {
    dh.setDispatch(async () => { throw new Error('session could not start') })
    expect(await send('notes:1', 'app-chat:app-1')).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('refuses a source that does not accept deliveries, before anything is charged or dispatched', async () => {
    for (let i = 0; i < 30; i++) {
      expect(await send('notes:1', 'archive:1')).toMatchObject({ ok: false, reason: 'read_only' })
    }
    expect(archive.dispatched).toHaveLength(0)
    expect(notes.notices).toHaveLength(0)
    // The pair budget was never spent by the refusals.
    expect(await send('notes:1', 'app-chat:app-1')).toMatchObject({ ok: true })
  })

  it('refuses external deliveries to a read-only source too', async () => {
    expect(
      await delivery.deliverExternalMessage({
        spaceId: SPACE,
        toConversationId: 'archive:1',
        turnInput: 'x',
        persist: { content: 'x', source: 'team-message', metadata: {} },
      })
    ).toMatchObject({ ok: false, reason: 'read_only' })
  })

  it('reports not_found for an id no registered source owns', async () => {
    expect(await send('notes:1', 'elsewhere:1')).toEqual({ ok: false, reason: 'not_found' })
  })

  it('delivers an external message through the target\'s own source, with both faces given by the caller', async () => {
    const result = await delivery.deliverExternalMessage({
      spaceId: SPACE,
      toConversationId: 'app-chat:app-1',
      turnInput: '[Team message from analyst]\n\nDone',
      persist: { content: 'Done', source: 'team-message', metadata: { teamId: 't1' } },
    })
    expect(result).toMatchObject({ ok: true, status: 'delivered' })
    expect(dh.dispatched[0].message).toEqual({
      turnInput: '[Team message from analyst]\n\nDone',
      record: { content: 'Done', source: 'team-message', metadata: { teamId: 't1' } },
    })
  })

  it('writes the rate-limit notice through the SENDER\'s source, naming the target from its own', async () => {
    dh.busy.add('app-chat:app-1') // keep queueing so only the breaker limits
    for (let i = 0; i < 22; i++) await send('notes:1', 'app-chat:app-1', `m-${i}`)

    expect(notes.notices).toHaveLength(1)
    expect(notes.notices[0].id).toBe('notes:1')
    expect(notes.notices[0].content).toContain('Analyst')
    expect(dh.notices).toHaveLength(0)
  })

  it('a sender in another source gets its notice from that source', async () => {
    notes.busy.add('notes:1')
    for (let i = 0; i < 22; i++) await send('app-chat:app-1', 'notes:1', `m-${i}`)

    expect(dh.notices).toHaveLength(1)
    expect(dh.notices[0].id).toBe('app-chat:app-1')
    expect(dh.notices[0].content).toContain('Notes thread')
  })

  it('keeps delivering when a source cannot write its notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      notes.source.writeNotice = () => { throw new Error('disk full') }
      dh.busy.add('app-chat:app-1')
      let last
      for (let i = 0; i < 22; i++) last = await send('notes:1', 'app-chat:app-1', `m-${i}`)
      expect(last).toEqual({ ok: false, reason: 'circuit_open' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cooldown notice not written'), expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })

  it('reclaims a reservation using the recipient source\'s own liveness answer', async () => {
    await send('notes:1', 'app-chat:app-1', 'first')
    dh.busy.delete('app-chat:app-1') // the turn died before ever reporting an end
    dh.live.delete('app-chat:app-1')

    expect(await send('notes:1', 'app-chat:app-1', 'second')).toMatchObject({ ok: true, status: 'delivered' })
    expect(dh.dispatched).toHaveLength(2)
  })

  it('does not reclaim while the recipient source still reports a live session', async () => {
    await send('notes:1', 'app-chat:app-1', 'first')
    dh.busy.delete('app-chat:app-1') // idle between turns, session alive

    expect(await send('notes:1', 'app-chat:app-1', 'second')).toEqual({ ok: true, status: 'queued' })
  })

  it('resolves a waitForReply between conversations of different sources, and reports no_reply when the target\'s source ends its turn silently', async () => {
    const waiting = delivery.deliverToConversationAndWait({
      spaceId: SPACE, fromConversationId: 'notes:1', toConversationId: 'app-chat:app-1',
      message: 'question', summary: 's', timeoutMs: 60_000,
    })
    await flush()
    expect(dh.dispatched).toHaveLength(1)
    expect(dh.dispatched[0].message.record.metadata).toMatchObject({ correlationId: expect.any(String) })

    dh.endTurn('app-chat:app-1')
    await expect(waiting).resolves.toEqual({ ok: true, outcome: { status: 'no_reply' } })

    const answered = delivery.deliverToConversationAndWait({
      spaceId: SPACE, fromConversationId: 'notes:1', toConversationId: 'app-chat:app-1',
      message: 'again', summary: 's', timeoutMs: 60_000,
    })
    await flush()
    expect(await send('app-chat:app-1', 'notes:1', 'the answer')).toEqual({ ok: true, status: 'resolved_pending_wait' })
    await expect(answered).resolves.toEqual({ ok: true, outcome: { status: 'replied', message: 'the answer' } })
  })

  it('frames a message from a sender that takes no messages as a one-way notice, unless it is waiting for the reply', async () => {
    const runs = createFakeSource({ kind: 'runs', prefix: 'app-run:', writable: false, readable: false })
    runs.seed('app-run:app-9:r1', 'Nightly run', '2026-01-01T00:00:00.000Z')
    sourceModule.registerConversationSource(runs.source)

    await send('app-run:app-9:r1', 'app-chat:app-1', 'fyi')
    expect(dh.dispatched.at(-1)!.message.turnInput).toContain('one-way notice')

    dh.endTurn('app-chat:app-1')
    await flush()
    const waiting = delivery.deliverToConversationAndWait({
      spaceId: SPACE, fromConversationId: 'app-run:app-9:r1', toConversationId: 'app-chat:app-1', message: 'ok?', summary: 's', timeoutMs: 60_000,
    })
    await flush()
    expect(dh.dispatched.at(-1)!.message.turnInput).not.toContain('one-way notice')

    // The answer reaches the waiting sender although its source takes no messages; a plain one is refused.
    expect(await send('app-chat:app-1', 'app-run:app-9:r1', 'yes')).toEqual({ ok: true, status: 'resolved_pending_wait' })
    await expect(waiting).resolves.toEqual({ ok: true, outcome: { status: 'replied', message: 'yes' } })
    expect(await send('app-chat:app-1', 'app-run:app-9:r1', 'anything else?')).toMatchObject({ ok: false, reason: 'read_only' })
  })
})

describe('admission', () => {
  const send = (from: string, to: string, message = 'hello') =>
    delivery.deliverToConversation({ spaceId: SPACE, fromConversationId: from, toConversationId: to, message, summary: 'sum' })
  const sendAndWait = (from: string, to: string) =>
    delivery.deliverToConversationAndWait({ spaceId: SPACE, fromConversationId: from, toConversationId: to, message: 'ok?', summary: 's', timeoutMs: 60_000 })

  let runs: Fake

  beforeEach(() => {
    notes.seed('notes:1', 'Notes thread', '2026-01-01T00:00:00.000Z', [line('user', 'n')])
    dh.seed('app-chat:app-1', 'Analyst', '2026-01-02T00:00:00.000Z', [line('user', 'a')])
    dh.seed('app-chat:app-off', 'Quiet one', '2026-01-03T00:00:00.000Z', [line('user', 'private')], 'collaboration is off')
    runs = createFakeSource({ kind: 'runs', prefix: 'app-run:', readable: false, writable: false, whyNotWritable: 'a run takes no replies' })
    runs.seed('app-run:a:live', 'Nightly run', '2026-01-04T00:00:00.000Z')
    runs.seed('app-run:a:done', 'scheduled run', '2026-01-01T00:00:00.000Z', [], 'the run has finished')
    sourceModule.registerConversationSource(runs.source)
    lifecycle.initConversationInterop()
  })

  it('lists only what other conversations may take part in', () => {
    const list = listRead.listConversationsForInterop(SPACE, 'caller')
    if (!list.ok) throw new Error('expected ok')
    expect(list.page.items.map((i) => i.id).sort()).toEqual(['app-chat:app-1', 'notes:1'])
  })

  it('reads an available conversation, and refuses the others with their reason', () => {
    expect(listRead.readConversationForInterop(SPACE, 'app-chat:app-1')).toMatchObject({ ok: true })
    expect(listRead.readConversationForInterop(SPACE, 'app-chat:app-off')).toEqual({ ok: false, reason: 'unavailable', detail: 'collaboration is off' })
    expect(listRead.readConversationForInterop(SPACE, 'app-run:a:live')).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(listRead.readConversationForInterop(SPACE, 'nothing:1')).toEqual({ ok: false, reason: 'not_found' })
  })

  it('refuses a send to each kind of conversation with the right reason, without charging or dispatching', async () => {
    for (let i = 0; i < 30; i++) {
      expect(await send('notes:1', 'app-chat:app-off')).toEqual({ ok: false, reason: 'unavailable', detail: 'collaboration is off' })
      expect(await send('notes:1', 'app-run:a:live')).toEqual({ ok: false, reason: 'read_only', detail: 'a run takes no replies' })
      expect(await send('notes:1', 'app-run:a:done')).toEqual({ ok: false, reason: 'unavailable', detail: 'the run has finished' })
    }
    expect(dh.dispatched).toHaveLength(0)
    expect(await send('notes:1', 'app-chat:app-1')).toMatchObject({ ok: true })
  })

  it('does not hold back the source itself: a user\'s own reads see a withheld conversation', () => {
    expect(dh.source.readTranscript(SPACE, 'app-chat:app-off')?.map((l) => l.content)).toEqual(['private'])
    expect(dh.source.list(SPACE).map((c) => c.id)).toContain('app-chat:app-off')
  })

  it('lets a waiting run be answered, until its collaboration is switched off', async () => {
    const waiting = sendAndWait('app-run:a:live', 'app-chat:app-1')
    await flush()
    runs.setUnavailable('app-run:a:live', 'collaboration is off')
    expect(await send('app-chat:app-1', 'app-run:a:live', 'yes')).toEqual({ ok: false, reason: 'unavailable', detail: 'collaboration is off' })

    runs.setUnavailable('app-run:a:live', undefined)
    expect(await send('app-chat:app-1', 'app-run:a:live', 'yes')).toEqual({ ok: true, status: 'resolved_pending_wait' })
    await expect(waiting).resolves.toEqual({ ok: true, outcome: { status: 'replied', message: 'yes' } })
  })

  it('refuses a queued send when the target switches collaboration off before its turn ends', async () => {
    dh.busy.add('app-chat:app-1')
    expect(await send('notes:1', 'app-chat:app-1', 'later')).toEqual({ ok: true, status: 'queued' })

    dh.setUnavailable('app-chat:app-1', 'collaboration is off')
    dh.endTurn('app-chat:app-1')
    await flush()

    expect(dh.dispatched).toHaveLength(0)
  })

  it('tells a waiting sender at once when its queued message is refused, instead of leaving it to time out', async () => {
    dh.busy.add('app-chat:app-1')
    const waiting = sendAndWait('notes:1', 'app-chat:app-1')
    await flush()

    dh.setUnavailable('app-chat:app-1', 'collaboration is off')
    dh.endTurn('app-chat:app-1')
    await flush()

    await expect(waiting).resolves.toEqual({ ok: true, outcome: { status: 'undelivered', reason: 'collaboration is off' } })
    expect(dh.dispatched).toHaveLength(0)
  })

  it('refuses an external delivery to a withheld conversation too', async () => {
    expect(
      await delivery.deliverExternalMessage({ spaceId: SPACE, toConversationId: 'app-chat:app-off', turnInput: 'x', persist: { content: 'x', source: 'team-message', metadata: {} } })
    ).toEqual({ ok: false, reason: 'unavailable', detail: 'collaboration is off' })
  })

  it('keeps the reason when an immediate dispatch is refused after it was accepted', async () => {
    const realGetMeta = dh.source.getMeta
    let calls = 0
    dh.source.getMeta = (space, id) => {
      const meta = realGetMeta(space, id)
      return meta && id === 'app-chat:app-1' && ++calls > 1 ? { ...meta, unavailable: 'collaboration is off' } : meta
    }

    expect(await send('notes:1', 'app-chat:app-1')).toEqual({ ok: false, reason: 'unavailable', detail: 'collaboration is off' })
    expect(dh.dispatched).toHaveLength(0)
  })
})
