/**
 * Binding a sink to its engine stamps results and forwards every hook; a hook
 * the binding leaves out silently stops reaching the sink.
 */

import { describe, it, expect, vi } from 'vitest'
import type { StreamResult } from '../../../../src/main/services/agent/stream-processor'
import { bindSinkToEngine, type TurnSink } from '../../../../src/main/services/agent/turn-sink'

describe('bindSinkToEngine', () => {
  it('passes on whether a turn that wrote nothing may simply end', () => {
    expect(bindSinkToEngine({ onTurnComplete: vi.fn(), acceptsQuietEnd: () => true }, 'halo').acceptsQuietEnd?.()).toBe(true)
    expect(bindSinkToEngine({ onTurnComplete: vi.fn(), acceptsQuietEnd: () => false }, 'halo').acceptsQuietEnd?.()).toBe(false)
    expect(bindSinkToEngine({ onTurnComplete: vi.fn() }, 'halo').acceptsQuietEnd?.()).toBe(false)
  })

  it('stamps the engine on the result it hands on', () => {
    const sink = { onTurnComplete: vi.fn() } satisfies TurnSink
    bindSinkToEngine(sink, 'halo').onTurnComplete({ finalContent: 'Done.' } as StreamResult)
    expect(sink.onTurnComplete).toHaveBeenCalledWith(expect.objectContaining({ finalContent: 'Done.', engineId: 'halo' }))
  })
})
