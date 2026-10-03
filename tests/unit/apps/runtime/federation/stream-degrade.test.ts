/**
 * A viewer whose socket is backed up receives stream batches reduced to their
 * milestones. It must still end with the whole reply and the completion.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { onAgentEvent } from '../../../../../src/main/services/agent/events'
import { createStreamReplay, milestoneOnly } from '../../../../../src/main/apps/runtime/federation/relay'
import type { StreamFrame, StreamFramesFrame } from '../../../../../src/main/apps/runtime/federation/types'

const SESSION = 'app-chat:app-1:team:office-1:epoch-1'

function frame(seq: number, channel: string, payload: Record<string, unknown>): StreamFrame {
  return { seq, kind: channel.endsWith('-delta') ? 'incremental' : 'milestone', channel, spaceId: 's', payload }
}

function batch(frames: StreamFrame[]): StreamFramesFrame {
  return { kind: 'stream-frames', officeId: 'office-1', sessionKey: SESSION, baseSeq: frames[0].seq, frames, originRun: 'run-1' }
}

describe('a backed-up viewer still converges on the full reply', () => {
  const disposers: Array<{ dispose(): void }> = []
  afterEach(() => disposers.splice(0).forEach((d) => d.dispose()))

  it('degraded batches keep every reply chunk and the completion', () => {
    const seen: Array<{ channel: string; data: Record<string, unknown> }> = []
    disposers.push(onAgentEvent((e) => {
      if (e.conversationId === SESSION) seen.push({ channel: e.channel, data: e.data as Record<string, unknown> })
    }))
    const batches = [
      batch([
        frame(1, 'agent:thought-delta', { delta: 'thinking…' }),
        frame(2, 'agent:message', { delta: 'Hello ' }),
        frame(3, 'agent:thought-delta', { delta: 'more' }),
      ]),
      batch([
        frame(4, 'agent:message', { delta: 'world' }),
        frame(5, 'agent:tool-call', { id: 't1' }),
        frame(6, 'agent:tool-result', { id: 't1' }),
      ]),
      batch([frame(7, 'agent:thought-delta', { delta: 'x' })]),
      batch([frame(8, 'agent:message', { delta: '!' }), frame(9, 'agent:complete', {})]),
    ]
    const replay = createStreamReplay()
    for (const b of batches) {
      const reduced = milestoneOnly(b)
      if (reduced) replay.apply(reduced)
    }
    const reply = seen.filter((e) => e.channel === 'agent:message').map((e) => e.data.delta).join('')
    expect(reply).toBe('Hello world!')
    expect(seen.some((e) => e.channel === 'agent:complete')).toBe(true)
    expect(seen.map((e) => e.channel)).toContain('agent:tool-result')
    expect(seen.some((e) => e.channel.endsWith('-delta'))).toBe(false)
  })

  it('a batch of only deltas is not sent at all; an all-milestone batch is sent as is', () => {
    expect(milestoneOnly(batch([frame(1, 'agent:thought-delta', {})]))).toBeNull()
    const whole = batch([frame(1, 'agent:message', { delta: 'a' })])
    expect(milestoneOnly(whole)).toBe(whole)
  })
})
