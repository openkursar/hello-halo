/**
 * Renderer recovery policy: a few failures in a window reload, the next one
 * halts for good, and a quiet window resets the count.
 */

import { describe, it, expect } from 'vitest'
import {
  RendererRecoveryPolicy,
  classifyRendererGone,
} from '../../../src/main/services/renderer-recovery'

describe('RendererRecoveryPolicy', () => {
  it('reloads the first three failures within a minute and halts on the fourth', () => {
    const policy = new RendererRecoveryPolicy()
    const t0 = 1_000_000
    expect(policy.record(t0).action).toBe('reload')
    expect(policy.record(t0 + 1_000).action).toBe('reload')
    expect(policy.record(t0 + 2_000).action).toBe('reload')
    expect(policy.record(t0 + 3_000)).toEqual({ action: 'halt', attempt: 4 })
    expect(policy.isHalted()).toBe(true)
  })

  it('never reloads or relaunches again once halted', () => {
    const policy = new RendererRecoveryPolicy({ maxReloadsPerWindow: 1 })
    policy.record(0)
    expect(policy.record(1).action).toBe('halt')
    // Even after the window elapses, a halted policy stays halted.
    expect(policy.record(10 * 60_000).action).toBe('ignore')
    expect(policy.record(20 * 60_000).action).toBe('ignore')
  })

  it('reloads a hung renderer without spending the crash budget', () => {
    const policy = new RendererRecoveryPolicy()
    for (let i = 0; i < 10; i++) expect(policy.recordHang().action).toBe('reload')
    expect(policy.record(0).action).toBe('reload')
    expect(policy.record(1).action).toBe('reload')
    expect(policy.record(2).action).toBe('reload')
    expect(policy.record(3).action).toBe('halt')
  })

  it('ignores hangs once halted', () => {
    const policy = new RendererRecoveryPolicy({ maxReloadsPerWindow: 0 })
    expect(policy.record(0).action).toBe('halt')
    expect(policy.recordHang().action).toBe('ignore')
  })

  it('starts a fresh window after a quiet minute', () => {
    const policy = new RendererRecoveryPolicy()
    policy.record(0)
    policy.record(1)
    policy.record(2)
    const decision = policy.record(60_010)
    expect(decision).toEqual({ action: 'reload', attempt: 1 })
    expect(policy.isHalted()).toBe(false)
  })
})

describe('classifyRendererGone', () => {
  it.each([
    ['oom', 'memory'],
    ['memory-eviction', 'memory'],
    ['killed', 'memory'],
    ['launch-failed', 'memory'],
    ['crashed', 'crash'],
    ['abnormal-exit', 'crash'],
    ['integrity-failure', 'crash'],
    ['clean-exit', 'exit'],
  ])('%s → %s', (reason, expected) => {
    expect(classifyRendererGone(reason)).toBe(expected)
  })
})
