/**
 * Main only gathers what clients did with the AI's request to show something:
 * a client that switched its screen wins, one that only kept the tab comes
 * next, and nobody answering means nobody is there. The wait ends as soon as
 * the answer is known, and never hangs on a client that went away.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  requestCanvasShow, expectCanvasShowReplies, receiveCanvasShowReply, onCanvasShowRequest,
} from '../../../../src/main/services/canvas-show/service'
import type { CanvasShowRequest } from '../../../../src/shared/types/canvas-show'

const base = { spaceId: 's1', conversationId: 'c1', target: { kind: 'file', path: '/w/a.md' }, bringForward: true } as const

let forwarded: CanvasShowRequest[]
let stop: () => void
beforeEach(() => {
  vi.useFakeTimers()
  forwarded = []
  stop = onCanvasShowRequest(request => forwarded.push(request))
})
afterEach(() => {
  stop()
  vi.useRealTimers()
})

describe('gathering the answers', () => {
  it('forwards the request to the transport with an id of its own', async () => {
    const outcome = requestCanvasShow(base)
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]).toMatchObject({ ...base, requestId: expect.any(String) })
    expectCanvasShowReplies(forwarded[0].requestId, 1)
    receiveCanvasShowReply({ requestId: forwarded[0].requestId, outcome: 'added' })
    expect(await outcome).toBe('added')
  })

  it('ends at once when one client switched its screen, without waiting for the others', async () => {
    const outcome = requestCanvasShow(base)
    const { requestId } = forwarded[0]
    expectCanvasShowReplies(requestId, 3)
    receiveCanvasShowReply({ requestId, outcome: 'shown' })
    expect(await outcome).toBe('shown')
  })

  it('prefers a client that showed it over the ones that only kept the tab, whatever the order', async () => {
    const outcome = requestCanvasShow(base)
    const { requestId } = forwarded[0]
    expectCanvasShowReplies(requestId, 2)
    receiveCanvasShowReply({ requestId, outcome: 'added' })
    receiveCanvasShowReply({ requestId, outcome: 'shown' })
    expect(await outcome).toBe('shown')
  })

  it.each([
    [['unavailable'], 'unavailable'],
    [['unavailable', 'added'], 'added'],
    [['unavailable', 'added', 'opened'], 'opened'],
    [['opened', 'shown'], 'shown'],
  ] as const)('reports the strongest confirmed outcome from %j', async (replies, expected) => {
    const outcome = requestCanvasShow(base)
    const { requestId } = forwarded[0]
    expectCanvasShowReplies(requestId, replies.length)
    for (const reply of replies) expect(receiveCanvasShowReply({ requestId, outcome: reply })).toBe(true)
    expect(await outcome).toBe(expected)
  })

  it('waits for every client the transport reached before saying the tab was only added', async () => {
    let settled = false
    const outcome = requestCanvasShow(base).then(value => { settled = true; return value })
    const { requestId } = forwarded[0]
    expectCanvasShowReplies(requestId, 2)
    receiveCanvasShowReply({ requestId, outcome: 'added' })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    receiveCanvasShowReply({ requestId, outcome: 'added' })
    expect(await outcome).toBe('added')
  })

  it('counts every transport that forwarded it, desktop window and remote clients alike', async () => {
    const outcome = requestCanvasShow(base)
    const { requestId } = forwarded[0]
    expectCanvasShowReplies(requestId, 1)
    expectCanvasShowReplies(requestId, 2)
    receiveCanvasShowReply({ requestId, outcome: 'added' })
    receiveCanvasShowReply({ requestId, outcome: 'added' })
    await vi.advanceTimersByTimeAsync(0)
    receiveCanvasShowReply({ requestId, outcome: 'added' })
    expect(await outcome).toBe('added')
  })

  it('says nobody is there when no client was reached', async () => {
    const outcome = requestCanvasShow(base)
    expectCanvasShowReplies(forwarded[0].requestId, 0)
    expect(await outcome).toBe('absent')
  })

  it('says nobody is there when nothing listens at all', async () => {
    stop()
    expect(await requestCanvasShow(base)).toBe('absent')
    stop = onCanvasShowRequest(() => {})
  })

  it('does not hang on a client that never answers: the replies that came decide', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const outcome = requestCanvasShow(base)
    const { requestId } = forwarded[0]
    expectCanvasShowReplies(requestId, 2)
    receiveCanvasShowReply({ requestId, outcome: 'added' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await outcome).toBe('added')
  })

  it('says nobody is there when the clients it reached all stay silent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const outcome = requestCanvasShow(base)
    expectCanvasShowReplies(forwarded[0].requestId, 1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await outcome).toBe('absent')
  })

  it('keeps simultaneous requests apart', async () => {
    const first = requestCanvasShow(base)
    const second = requestCanvasShow(base)
    const [a, b] = forwarded
    expectCanvasShowReplies(a.requestId, 1)
    expectCanvasShowReplies(b.requestId, 1)
    receiveCanvasShowReply({ requestId: b.requestId, outcome: 'shown' })
    receiveCanvasShowReply({ requestId: a.requestId, outcome: 'added' })
    expect(await first).toBe('added')
    expect(await second).toBe('shown')
  })

  it('ignores a late or unknown reply', () => {
    expect(receiveCanvasShowReply({ requestId: 'no-such-request', outcome: 'shown' })).toBe(true)
  })

  it.each([
    [null], [undefined], ['x'], [{}], [{ requestId: 1, outcome: 'shown' }],
    [{ requestId: 'r', outcome: 'maybe' }], [{ requestId: 'r' }],
  ])('rejects a malformed reply: %j', value => {
    expect(receiveCanvasShowReply(value)).toBe(false)
  })
})
