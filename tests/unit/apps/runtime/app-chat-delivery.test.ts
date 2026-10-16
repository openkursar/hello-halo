import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppChatRequest } from '../../../../src/main/apps/runtime/app-chat'

const env = vi.hoisted(() => ({
  busy: false,
  emitError: vi.fn(),
  identity: undefined as string | undefined,
  inject: vi.fn((_key: string, _messages: any[]) => true),
  accepted: [] as Array<() => void>,
  changes: new Set<(key: string) => void>(),
  events: new Set<(event: { channel: string; conversationId: string }) => void>(),
  writeStoppedInput: vi.fn(),
  markInputsStopped: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent', () => ({
  formatCanvasContext: () => '',
  emitAgentEvent: env.emitError,
  onAgentEvent: (listener: (event: any) => void) => {
    env.events.add(listener)
    return { dispose: () => env.events.delete(listener) }
  },
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  isAppChatConversationGenerating: () => env.busy,
  getAppChatTurnIdentity: () => env.identity,
  appChatMessageIdentity: (permission: any, external: boolean) => permission?.isOwner === false ? `guest:${JSON.stringify(permission.guestPolicy ?? {})}` : external ? 'external' : 'owner',
  injectIntoAppChatBatch: env.inject,
  keepStoppedInputs: (_key: string, records: unknown[], unwritten: Array<Record<string, unknown>> = []) => {
    if (records.length) env.markInputsStopped(records)
    for (const input of unwritten) env.writeStoppedInput(input.content, input.images, input.provenance, input.references, input.teamOrigin)
  },
  refreshAppChatTurnStarts: () => {},
  onAppChatConversationChange: (listener: (key: string) => void) => {
    env.changes.add(listener)
    return () => env.changes.delete(listener)
  },
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({
  peekAppChatSink: () => ({
    canObserveLiveTurn: () => true,
    observeLiveTurn: () => {
      let resolve!: () => void
      const done = new Promise<void>(settle => { resolve = settle })
      env.accepted.push(resolve)
      return { done, cancel: () => resolve() }
    },
  }),
}))
vi.mock('../../../../src/main/apps/runtime/im-permission-registry', () => ({ getImPermissionContext: () => undefined }))
vi.mock('../../../../src/main/apps/runtime/team/external-origin', () => ({ peekTurnOrigin: (_key: string, trigger: any) => trigger.external === true }))

import { createAppChatDelivery } from '../../../../src/main/apps/runtime/app-chat-delivery'

const KEY = 'app-chat:person'
const request = (message: string, extra: Partial<AppChatRequest> = {}): AppChatRequest => ({
  appId: 'person', spaceId: 'space', conversationId: KEY, message, ...extra,
})
const guest = { senderId: 'guest', senderName: 'Guest', isOwner: false, guestPolicy: { allowedTools: [] } }

beforeEach(() => {
  vi.useFakeTimers()
  env.busy = false
  env.identity = undefined
  env.inject.mockReset().mockReturnValue(true)
  env.emitError.mockClear()
  env.accepted = []
  env.changes.clear()
  env.events.clear()
  env.writeStoppedInput.mockClear()
  env.markInputsStopped.mockClear()
})
afterEach(() => {
  for (const resolve of env.accepted) resolve()
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function idle(): Promise<void> {
  env.busy = false
  env.identity = undefined
  for (const listener of env.changes) listener(KEY)
  await vi.advanceTimersByTimeAsync(0)
}

describe('digital-human message admission', () => {
  it('starts idle work and releases the mailbox after completion', async () => {
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    await delivery.send(request('first'))
    await Promise.resolve()
    await delivery.send(request('second'))
    expect(run.mock.calls.map(call => (call[0] as AppChatRequest).message)).toEqual(['first', 'second'])
  })

  it('joins the owner turn and waits for its consuming reply without starting another round', async () => {
    env.busy = true
    env.identity = 'owner'
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    const accepted = vi.fn()
    let completed = false
    const sent = delivery.send(request('also inspect the logs', { onMessageAccepted: accepted })).then(() => { completed = true })
    await Promise.resolve()
    expect(env.inject).toHaveBeenCalledOnce()
    expect(accepted).toHaveBeenCalledOnce()
    expect(completed).toBe(false)
    expect(run).not.toHaveBeenCalled()
    env.accepted[0]()
    await sent
    expect(completed).toBe(true)
  })

  it('pushes the reply of a merged turn once, not once per merged message', async () => {
    env.busy = true
    env.identity = 'owner'
    const run = vi.fn(async (merged: AppChatRequest) => { merged.onReply?.('one answer') })
    const delivery = createAppChatDelivery(run)
    const firstReply = vi.fn()
    const secondReply = vi.fn()
    const first = delivery.send(request('guest first', { imPermission: guest, onReply: firstReply }))
    const second = delivery.send(request('guest second', { imPermission: guest, onReply: secondReply }))
    await idle()
    await Promise.all([first, second])
    expect(run).toHaveBeenCalledOnce()
    expect(firstReply).toHaveBeenCalledOnce()
    expect(firstReply).toHaveBeenCalledWith('one answer', undefined)
    expect(secondReply).not.toHaveBeenCalled()
  })

  it('gives every merged message the answer while pushing it once', async () => {
    env.busy = true
    env.identity = 'owner'
    const run = vi.fn(async (merged: AppChatRequest) => {
      merged.onResult?.('one answer')
      merged.onReply?.('one answer')
    })
    const delivery = createAppChatDelivery(run)
    const results = [vi.fn(), vi.fn()]
    const replies = [vi.fn(), vi.fn()]
    const sent = ['remote first', 'remote second'].map((text, index) => delivery.send(request(text, {
      teamContext: { teamId: 't', epochId: 'e', correlationId: `c${index}`, fromAppId: null, wait: true, kind: 'message', external: true },
      onResult: results[index], onReply: replies[index],
    })))
    await idle()
    await Promise.all(sent)
    expect(run).toHaveBeenCalledOnce()
    for (const result of results) expect(result).toHaveBeenCalledWith('one answer', undefined)
    expect(replies[0]).toHaveBeenCalledOnce()
    expect(replies[1]).not.toHaveBeenCalled()
  })

  it('keeps guest messages out of an owner turn and preserves their separate records in one later input', async () => {
    env.busy = true
    env.identity = 'owner'
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    const first = delivery.send(request('guest first', { imPermission: guest }))
    const second = delivery.send(request('guest second', { imPermission: guest }))
    expect(env.inject).not.toHaveBeenCalled()
    await idle()
    await Promise.all([first, second])
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0]).toMatchObject({
      message: 'guest first\n\nguest second',
      imPermission: guest,
      recordedMessages: [{ content: 'guest first' }, { content: 'guest second' }],
    })
  })

  it('keeps remote work out of a locally started owner turn', async () => {
    env.busy = true
    env.identity = 'owner'
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    const sent = delivery.send(request('remote report', {
      teamContext: { teamId: 'team', epochId: 'epoch', correlationId: 'message', fromAppId: 'other', wait: false, kind: 'message', external: true },
    }))
    expect(env.inject).not.toHaveBeenCalled()
    await idle()
    await sent
    expect(run).toHaveBeenCalledOnce()
  })

  it('delivers same-policy guests into an already restricted turn', async () => {
    env.busy = true
    env.identity = `guest:${JSON.stringify(guest.guestPolicy)}`
    const delivery = createAppChatDelivery(vi.fn(async (_request: AppChatRequest) => {}))
    const sent = delivery.send(request('guest addition', { imPermission: guest }))
    expect(env.inject).toHaveBeenCalledOnce()
    env.accepted[0]()
    await sent
  })

  it('flushes all startup arrivals in order as soon as the engine announces a live turn', async () => {
    env.busy = true
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    const first = delivery.send(request('first addition'))
    const second = delivery.send(request('second addition'))
    expect(env.inject).not.toHaveBeenCalled()
    env.identity = 'owner'
    for (const listener of env.events) listener({ channel: 'agent:turn-start', conversationId: KEY })
    expect(env.inject).toHaveBeenCalledOnce()
    expect(env.inject.mock.calls[0][1].map((message: any) => message.text)).toEqual(['first addition', 'second addition'])
    for (const resolve of env.accepted) resolve()
    await Promise.all([first, second])
    expect(run).not.toHaveBeenCalled()
  })

  it('retries as a new turn when live acceptance races completion', async () => {
    env.busy = true
    env.identity = 'owner'
    env.inject.mockImplementation(() => { env.busy = false; return false })
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    await delivery.send(request('arrived at completion'))
    expect(run).toHaveBeenCalledOnce()
    expect(env.inject).toHaveBeenCalledOnce()
  })

  it('keeps only the latest waiting reminder and rechecks cancellation before dispatch', async () => {
    env.busy = true
    env.identity = 'external'
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    const old = delivery.send(request('old check', { coalescingKey: 'check' }))
    let relevant = true
    const latest = delivery.send(request('latest check', { coalescingKey: 'check', canStart: () => relevant }))
    await old
    relevant = false
    await idle()
    await latest
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects pending owner messages on stop without starting them afterward', async () => {
    env.busy = true
    env.identity = 'external'
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    const sent = delivery.send(request('pending owner request'))
    const rejected = expect(sent).rejects.toThrow('cancelled')
    delivery.discard(KEY)
    await rejected
    await idle()
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps a due reminder and a teammate message waiting through a stop, and runs them afterwards', async () => {
    env.busy = true
    env.identity = 'external'
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    let reminderRequest!: AppChatRequest
    reminderRequest = request('reminder due', { refreshBeforeDelivery: () => reminderRequest })
    const reminder = delivery.send(reminderRequest)
    const owner = delivery.send(request('owner request'))
    const ownerRejected = expect(owner).rejects.toThrow('cancelled')
    delivery.discard(KEY)
    await ownerRejected
    await idle()
    await reminder
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0].message).toBe('reminder due')

    env.busy = true
    env.identity = 'owner'
    const teammate = delivery.send(request('teammate update', {
      teamContext: { teamId: 't', epochId: 'e', correlationId: 'c', fromAppId: 'peer', wait: false, kind: 'message', external: true },
    }))
    delivery.discard(KEY)
    await idle()
    await teammate
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][0].message).toBe('teammate update')
  })
})


describe('deferred notice authority and delivery lifetime', () => {
  it('refreshes standing before a starting owner turn becomes injectable', async () => {
    env.busy = true
    let permission: typeof guest | undefined
    const refresh = () => request('reminder', { imPermission: permission, refreshBeforeDelivery: refresh })
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    const sent = delivery.send(refresh())
    permission = guest
    env.identity = 'owner'
    for (const listener of env.events) listener({ channel: 'agent:turn-start', conversationId: KEY })
    expect(env.inject).not.toHaveBeenCalled()
    await idle()
    await sent
    expect(run.mock.calls[0][0].imPermission).toEqual(guest)
  })

  it('keeps a refreshed earlier notice ahead of newer messages in its new permission group', async () => {
    env.busy = true
    env.identity = 'external'
    let permission: typeof guest | undefined
    const refresh = () => request('earlier reminder', { imPermission: permission, refreshBeforeDelivery: refresh })
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    const earlier = delivery.send(refresh())
    const later = delivery.send(request('later guest message', { imPermission: guest }))
    permission = guest
    await idle()
    await Promise.all([earlier, later])
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0].message).toBe('earlier reminder\n\nlater guest message')
    expect(run.mock.calls[0][0].imPermission).toEqual(guest)
  })

  it('does not let a retired dispatch finalizer release the successor reservation', async () => {
    const finishes: Array<() => void> = []
    const run = vi.fn((_request: AppChatRequest) => new Promise<void>(resolve => { finishes.push(resolve); env.busy = true }))
    const delivery = createAppChatDelivery(run)
    const first = delivery.send(request('first'))
    const second = delivery.send(request('second'))
    env.busy = false
    run.mock.calls[0][0].onSessionRetired?.()
    expect(run).toHaveBeenCalledTimes(2)
    finishes[0]()
    await first
    await Promise.resolve()
    env.busy = false
    const third = delivery.send(request('third'))
    expect(run).toHaveBeenCalledTimes(2)
    finishes[1]()
    await second
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(3)
    env.busy = false
    finishes[2]()
    await third
  })

  it('removes listeners, rejects pending work, and prevents late completion from restarting it after shutdown', async () => {
    let finish!: () => void
    const run = vi.fn((_request: AppChatRequest) => new Promise<void>(resolve => { finish = resolve; env.busy = true }))
    const delivery = createAppChatDelivery(run)
    const first = delivery.send(request('running'))
    await Promise.resolve()
    const second = delivery.send(request('pending'))
    const rejected = expect(second).rejects.toThrow('shut down')
    delivery.dispose()
    await rejected
    expect(env.events.size).toBe(0)
    expect(env.changes.size).toBe(0)
    env.busy = false
    finish()
    await first
    await Promise.resolve()
    expect(run).toHaveBeenCalledOnce()
    await expect(delivery.send(request('after shutdown'))).rejects.toThrow('shut down')
  })
})


describe('chat delivery admission failures', () => {
  it('reports mailbox capacity refusal once to the conversation and rejects its caller', async () => {
    env.busy = true
    env.identity = 'external'
    const delivery = createAppChatDelivery(vi.fn(async () => {}))
    const pending = Array.from({ length: 128 }, (_, index) => delivery.send(request(`pending ${index}`)).catch(() => {}))
    await expect(delivery.send(request('over capacity'))).rejects.toThrow('mailbox is full')
    expect(env.emitError).toHaveBeenCalledTimes(1)
    expect(env.emitError).toHaveBeenCalledWith('agent:error', 'space', KEY, expect.objectContaining({ type: 'error', error: expect.stringContaining('mailbox is full') }))
    delivery.dispose()
    await Promise.all(pending)
    expect(env.emitError).toHaveBeenCalledTimes(1)
  })

  it('does not duplicate failures emitted by the accepted run itself', async () => {
    const delivery = createAppChatDelivery(async () => { throw new Error('reported by run') })
    await expect(delivery.send(request('start'))).rejects.toThrow('reported by run')
    expect(env.emitError).not.toHaveBeenCalled()
  })
})


describe('a person stopping the chat', () => {
  it('voids their own waiting message, keeping it in the record, and holds the rest without starting a turn', async () => {
    env.busy = true
    env.identity = 'external'
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    let reminderRequest!: AppChatRequest
    reminderRequest = request('reminder due', { refreshBeforeDelivery: () => reminderRequest })
    void delivery.send(reminderRequest)
    const owner = delivery.send(request('owner request', { references: [] }))
    delivery.holdAfterStop(KEY)
    await expect(owner).resolves.toBeUndefined()
    expect(env.writeStoppedInput).toHaveBeenCalledWith('owner request', undefined, undefined, [], undefined)
    await idle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).not.toHaveBeenCalled()

    await delivery.send(request('after the stop'))
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0].message).toBe('reminder due\n\nafter the stop')
  })

  it('takes back what a stop left unread without recording it twice', async () => {
    env.busy = true
    env.identity = 'owner'
    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    let reminderRequest!: AppChatRequest
    reminderRequest = request('reminder due', { refreshBeforeDelivery: () => reminderRequest })
    void delivery.send(reminderRequest)
    expect(env.inject).toHaveBeenCalledOnce()
    const [, batch, takenBack] = env.inject.mock.calls[0] as unknown as [string, Array<{ personal?: boolean }>, (indexes: number[]) => void]
    expect(batch[0].personal).toBe(false)
    delivery.holdAfterStop(KEY)
    takenBack([0])
    await idle()
    expect(run).not.toHaveBeenCalled()

    await delivery.send(request('owner again'))
    expect(run).toHaveBeenCalledOnce()
    const merged = run.mock.calls[0][0]
    expect(merged.message).toBe('reminder due\n\nowner again')
    expect(merged.recordedMessages?.map(item => item.content)).toEqual(['owner again'])
  })

  async function heldBackBatch(records: (request: AppChatRequest) => Array<{ id: string }>) {
    env.busy = true
    env.identity = 'external'
    let finish!: () => void
    const run = vi.fn((_request: AppChatRequest) => new Promise<void>(resolve => { finish = resolve }))
    const delivery = createAppChatDelivery(run)
    let reminderRequest!: AppChatRequest
    reminderRequest = request('reminder due', { refreshBeforeDelivery: () => reminderRequest })
    const reminder = delivery.send(reminderRequest)
    const owner = delivery.send(request('owner request'))
    await idle()
    expect(run).toHaveBeenCalledOnce()
    const started = run.mock.calls[0][0]
    // A person's stop reaches the batch on its way to the engine.
    delivery.holdAfterStop(KEY)
    started.onHeldBack?.(records(started) as never)
    finish()
    await Promise.all([reminder, owner])
    await idle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledOnce()
    void delivery.send(request('after the stop'))
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    finish()
    return run.mock.calls[1][0]
  }

  it("voids the person's own words in a batch a stop held back on its way, and keeps the rest for the next turn", async () => {
    const next = await heldBackBatch(() => [])
    expect(env.writeStoppedInput).toHaveBeenCalledWith('owner request', undefined, undefined, undefined, undefined)
    expect(next.message).toBe('reminder due\n\nafter the stop')
    expect(next.recordedMessages?.map(item => item.content)).toEqual(['reminder due', 'after the stop'])
  })

  it('marks the records already written for a held-back batch and does not write them again', async () => {
    const next = await heldBackBatch(started => (started.recordedMessages ?? []).map((_item, index) => ({ id: `record-${index}` })))
    expect(env.markInputsStopped).toHaveBeenCalledWith([{ id: 'record-1' }])
    expect(env.writeStoppedInput).not.toHaveBeenCalled()
    expect(next.message).toBe('reminder due\n\nafter the stop')
    expect(next.recordedMessages?.map(item => item.content)).toEqual(['after the stop'])
  })
})
