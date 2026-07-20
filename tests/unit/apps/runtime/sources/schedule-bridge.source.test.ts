/**
 * Unit tests for apps/runtime/sources/schedule-bridge.source (ScheduleBridgeSource).
 *
 * The bridge adapts a minimal SchedulerLike into AutomationEvent emission.
 * A FakeScheduler records the registered onJobDue handler and lets the test
 * fire jobs. These tests pin the mapping + lifecycle branches the router
 * relies on:
 *
 *   - identity: id/type are the fixed 'schedule-bridge' discriminators
 *   - start() with a scheduler subscribes; a fired job maps to a
 *     'schedule.due' event with the job fields under payload (metadata
 *     defaulting to {}), no dedupKey
 *   - start() with a null scheduler is a no-op (nothing subscribed)
 *   - setScheduler() before start does not subscribe; after start subscribes
 *     immediately (late-wiring path)
 *   - stop() gates emission: a job firing after stop() produces no event
 */

import { describe, it, expect, vi } from 'vitest'
import { ScheduleBridgeSource } from '../../../../../src/main/apps/runtime/sources/schedule-bridge.source'
import type {
  SchedulerLike,
  ScheduledJobInfo,
} from '../../../../../src/main/apps/runtime/sources/schedule-bridge.source'
import type { AutomationEventInput } from '../../../../../src/main/apps/runtime/event-types'

class FakeScheduler implements SchedulerLike {
  handler: ((job: ScheduledJobInfo) => void) | null = null
  onJobDue(handler: (job: ScheduledJobInfo) => void): void {
    this.handler = handler
  }
  fire(job: ScheduledJobInfo): void {
    this.handler?.(job)
  }
}

function makeJob(overrides: Partial<ScheduledJobInfo> = {}): ScheduledJobInfo {
  return {
    jobId: 'job-1',
    jobName: 'Daily digest',
    scheduledAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('ScheduleBridgeSource — identity', () => {
  it('exposes the fixed id and type', () => {
    const src = new ScheduleBridgeSource(null)
    expect(src.id).toBe('schedule-bridge')
    expect(src.type).toBe('schedule-bridge')
  })
})

describe('ScheduleBridgeSource — start + mapping', () => {
  it('maps a fired job to a schedule.due event', () => {
    const scheduler = new FakeScheduler()
    const src = new ScheduleBridgeSource(scheduler)
    const emit = vi.fn()
    src.start(emit)

    scheduler.fire(makeJob({ metadata: { appId: 'a1' } }))

    expect(emit).toHaveBeenCalledTimes(1)
    const event = emit.mock.calls[0][0] as AutomationEventInput
    expect(event.type).toBe('schedule.due')
    expect(event.source).toBe('schedule-bridge')
    expect(event.payload).toEqual({
      jobId: 'job-1',
      jobName: 'Daily digest',
      metadata: { appId: 'a1' },
      scheduledAt: 1_700_000_000_000,
    })
    expect(event.dedupKey).toBeUndefined()
  })

  it('defaults metadata to {} when the job omits it', () => {
    const scheduler = new FakeScheduler()
    const src = new ScheduleBridgeSource(scheduler)
    const emit = vi.fn()
    src.start(emit)
    scheduler.fire(makeJob())
    const event = emit.mock.calls[0][0] as AutomationEventInput
    expect(event.payload.metadata).toEqual({})
  })

  it('does not subscribe when started with a null scheduler', () => {
    const src = new ScheduleBridgeSource(null)
    const emit = vi.fn()
    // No scheduler to fire; simply must not throw and must emit nothing.
    expect(() => src.start(emit)).not.toThrow()
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('ScheduleBridgeSource — setScheduler late wiring', () => {
  it('does not subscribe when set before start', () => {
    const src = new ScheduleBridgeSource(null)
    const scheduler = new FakeScheduler()
    src.setScheduler(scheduler)
    // Not started yet → no handler registered.
    expect(scheduler.handler).toBeNull()
  })

  it('subscribes immediately when set after start (late-wire)', () => {
    const src = new ScheduleBridgeSource(null)
    const emit = vi.fn()
    src.start(emit) // no scheduler yet

    const scheduler = new FakeScheduler()
    src.setScheduler(scheduler)
    expect(scheduler.handler).not.toBeNull()

    scheduler.fire(makeJob())
    expect(emit).toHaveBeenCalledTimes(1)
  })
})

describe('ScheduleBridgeSource — stop gating', () => {
  it('emits nothing for a job that fires after stop()', () => {
    const scheduler = new FakeScheduler()
    const src = new ScheduleBridgeSource(scheduler)
    const emit = vi.fn()
    src.start(emit)
    src.stop()

    scheduler.fire(makeJob())
    expect(emit).not.toHaveBeenCalled()
  })
})
