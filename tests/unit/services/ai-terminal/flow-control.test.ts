/**
 * Tests for the terminal flow controller (ack model, main-side policy).
 * Watermarks: pause when any attached viewer's unacked backlog exceeds 100k
 * chars; resume once every viewer is back under 5k. No viewers = no gating.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { TerminalFlowController } from '../../../../src/main/services/ai-terminal/flow-control'

const HIGH = 100_000
const LOW = 5_000

let paused: string[]
let resumed: string[]
let flow: TerminalFlowController

beforeEach(() => {
  paused = []
  resumed = []
  flow = new TerminalFlowController(
    (id) => paused.push(id),
    (id) => resumed.push(id)
  )
})

describe('TerminalFlowController', () => {
  it('never pauses without an attached viewer', () => {
    flow.onData('s1', HIGH * 10)
    expect(paused).toEqual([])
  })

  it('pauses once the high watermark is crossed and only once', () => {
    flow.attach('s1', 'v1')
    flow.onData('s1', HIGH)
    expect(paused).toEqual([])
    flow.onData('s1', 1)
    expect(paused).toEqual(['s1'])
    flow.onData('s1', 50_000)
    expect(paused).toEqual(['s1'])
  })

  it('resumes only after acks bring the backlog under the low watermark', () => {
    flow.attach('s1', 'v1')
    flow.onData('s1', HIGH + 1)
    expect(paused).toEqual(['s1'])
    flow.ack('s1', 'v1', HIGH - LOW)
    expect(resumed).toEqual([])
    flow.ack('s1', 'v1', 2)
    expect(resumed).toEqual(['s1'])
  })

  it('gates on the slowest viewer when several are attached', () => {
    flow.attach('s1', 'fast')
    flow.attach('s1', 'slow')
    flow.onData('s1', HIGH + 1)
    expect(paused).toEqual(['s1'])
    flow.ack('s1', 'fast', HIGH + 1)
    expect(resumed).toEqual([])
    flow.ack('s1', 'slow', HIGH)
    expect(resumed).toEqual(['s1'])
  })

  it('resumes when the lagging viewer detaches', () => {
    flow.attach('s1', 'v1')
    flow.onData('s1', HIGH + 1)
    expect(paused).toEqual(['s1'])
    flow.detach('s1', 'v1')
    expect(resumed).toEqual(['s1'])
  })

  it('releases every attachment of a disconnected viewer', () => {
    flow.attach('s1', 'ws-client')
    flow.attach('s2', 'ws-client')
    flow.onData('s1', HIGH + 1)
    flow.onData('s2', HIGH + 1)
    expect(paused).toEqual(['s1', 's2'])
    flow.detachViewer('ws-client')
    expect(resumed).toEqual(['s1', 's2'])
  })

  it('drop() clears state without emitting resume (session is gone)', () => {
    flow.attach('s1', 'v1')
    flow.onData('s1', HIGH + 1)
    flow.drop('s1')
    expect(resumed).toEqual([])
    // Stale acks after drop are ignored.
    flow.ack('s1', 'v1', HIGH)
    expect(resumed).toEqual([])
  })

  it('ignores acks from viewers that never attached', () => {
    flow.attach('s1', 'v1')
    flow.onData('s1', HIGH + 1)
    flow.ack('s1', 'ghost', HIGH + 1)
    expect(resumed).toEqual([])
  })

  it('re-attach of a stale viewer resumes a paused session (reload recovery)', () => {
    // Renderer reloaded mid-pause: the old attachment's backlog is stale and
    // nobody is left to ack. Re-attaching under the same viewer id must reset
    // the backlog AND resume — a paused pty emits no data to ack against.
    flow.attach('s1', 'desktop')
    flow.onData('s1', HIGH + 1)
    expect(paused).toEqual(['s1'])
    flow.attach('s1', 'desktop')
    expect(resumed).toEqual(['s1'])
  })

  it('attach of an additional viewer does not resume while another lags', () => {
    flow.attach('s1', 'slow')
    flow.onData('s1', HIGH + 1)
    expect(paused).toEqual(['s1'])
    flow.attach('s1', 'fresh')
    expect(resumed).toEqual([])
  })

  it('a late-attaching viewer starts with a clean backlog', () => {
    flow.attach('s1', 'v1')
    flow.onData('s1', 60_000)
    flow.attach('s1', 'v2')
    flow.onData('s1', 50_000)
    // v1: 110k (paused); v2 only accounts data seen since attach: 50k.
    expect(paused).toEqual(['s1'])
    flow.ack('s1', 'v1', 110_000)
    // v2 still holds 50k > LOW — stays paused until v2 acks too.
    expect(resumed).toEqual([])
    flow.ack('s1', 'v2', 47_000)
    expect(resumed).toEqual(['s1'])
  })
})
