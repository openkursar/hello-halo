/**
 * HTTP-mode telemetry batching: reports leave together after a short delay or
 * when the batch fills, and an older desktop server that only accepts single
 * reports still receives every report.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/api/transport', () => ({
  getAuthToken: () => null,
  getRemoteServerUrl: () => 'http://host',
}))

const { createReportBatcher } = await import('../../../src/renderer/api/analytics-batch')
type PostResult = Awaited<ReturnType<Parameters<typeof createReportBatcher>[0]['post']>>

function setup(answer: (body: Record<string, unknown>) => PostResult = () => 'ok') {
  const posts: Record<string, unknown>[] = []
  const post = vi.fn(async (body: Record<string, unknown>) => {
    posts.push(body)
    return answer(body)
  })
  const batcher = createReportBatcher({
    post,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
  return { batcher, posts }
}

describe('report batcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('sends queued reports together once the delay passes', () => {
    const { batcher, posts } = setup()
    batcher.enqueue({ event: 'home.view' })
    batcher.enqueue({ event: 'home.first_paint', properties: { cold: true } })
    expect(posts).toEqual([])

    vi.advanceTimersByTime(5_000)
    expect(posts).toEqual([{ events: [{ event: 'home.view' }, { event: 'home.first_paint', properties: { cold: true } }] }])
  })

  it('sends at once when the batch fills', () => {
    const { batcher, posts } = setup()
    for (let i = 0; i < 50; i++) batcher.enqueue({ event: 'home.chip.click' })
    expect(posts).toHaveLength(1)
    expect((posts[0].events as unknown[]).length).toBe(50)

    vi.advanceTimersByTime(5_000)
    expect(posts).toHaveLength(1)
  })

  it('flushes on demand and sends nothing when empty', () => {
    const { batcher, posts } = setup()
    batcher.flush()
    expect(posts).toEqual([])

    batcher.enqueue({ event: 'home.view' })
    batcher.flush()
    expect(posts).toEqual([{ events: [{ event: 'home.view' }] }])
  })

  it('falls back to single reports for a server that rejects batches', async () => {
    const { batcher, posts } = setup((body) => ('events' in body ? 'legacy' : 'ok'))
    batcher.enqueue({ event: 'home.view' })
    batcher.enqueue({ event: 'home.chip.click' })
    batcher.flush()
    await vi.runAllTimersAsync()

    expect(posts).toEqual([
      { events: [{ event: 'home.view' }, { event: 'home.chip.click' }] },
      { event: 'home.view' },
      { event: 'home.chip.click' },
    ])

    batcher.enqueue({ event: 'home.empty_state.view' })
    batcher.flush()
    expect(posts.at(-1)).toEqual({ event: 'home.empty_state.view' })
  })

  it('drops a failed batch instead of retrying', async () => {
    const { batcher, posts } = setup(() => 'failed')
    batcher.enqueue({ event: 'home.view' })
    batcher.flush()
    await vi.runAllTimersAsync()
    expect(posts).toHaveLength(1)
  })
})
