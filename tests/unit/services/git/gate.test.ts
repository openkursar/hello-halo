/**
 * The gate in front of file-content reads: a few run at once, the rest wait in
 * order, and a request is refused (GIT_BUSY, nothing run) when the line is
 * full, when it waited too long, or when its caller went away.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { rmSync } from 'fs'
import { Gate } from '../../../../src/main/services/git/gate'
import { getChangeList, readFileContents } from '../../../../src/main/services/git'
import { initRepo, isolateGit, makeTempDir } from './_repo'

const { spaces } = vi.hoisted(() => ({ spaces: new Map<string, string>() }))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpaceDir: (spaceId: string) => spaces.get(spaceId) ?? '',
}))

/** A task that runs until released, recording how many run at once. */
function harness() {
  let running = 0
  let peak = 0
  const started: number[] = []
  const releases = new Map<number, () => void>()
  const task = (id: number) => () =>
    new Promise<number>((resolve) => {
      running++
      peak = Math.max(peak, running)
      started.push(id)
      releases.set(id, () => {
        running--
        resolve(id)
      })
    })
  const release = (id: number) => releases.get(id)!()
  return { task, release, started, peak: () => peak }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.useRealTimers()
})

describe('Gate', () => {
  it('runs up to its concurrency at once and the rest in arrival order', async () => {
    const gate = new Gate({ concurrency: 2, maxQueued: 10, maxWaitMs: 60_000 })
    const h = harness()
    const results = [1, 2, 3, 4, 5].map((id) => gate.run(h.task(id)))
    await tick()
    expect(h.started).toEqual([1, 2])
    h.release(2)
    await tick()
    expect(h.started).toEqual([1, 2, 3])
    h.release(1)
    h.release(3)
    await tick()
    expect(h.started).toEqual([1, 2, 3, 4, 5])
    h.release(4)
    h.release(5)
    expect(await Promise.all(results)).toEqual([1, 2, 3, 4, 5])
    expect(h.peak()).toBe(2)
  })

  it('refuses a request at once when the line is full, without running it', async () => {
    const gate = new Gate({ concurrency: 1, maxQueued: 2, maxWaitMs: 60_000 })
    const h = harness()
    const accepted = [1, 2, 3].map((id) => gate.run(h.task(id)))
    const refused = gate.run(h.task(4))
    await expect(refused).rejects.toMatchObject({ code: 'GIT_BUSY' })
    await tick()
    h.release(1)
    await tick()
    h.release(2)
    await tick()
    h.release(3)
    expect(await Promise.all(accepted)).toEqual([1, 2, 3])
    expect(h.started).toEqual([1, 2, 3])
  })

  it('gives up on a request that waited too long, and the line moves on', async () => {
    vi.useFakeTimers()
    const gate = new Gate({ concurrency: 1, maxQueued: 5, maxWaitMs: 1_000 })
    const h = harness()
    const first = gate.run(h.task(1))
    const late = gate.run(h.task(2))
    const lateResult = expect(late).rejects.toMatchObject({ code: 'GIT_BUSY' })
    await vi.advanceTimersByTimeAsync(1_001)
    await lateResult
    const next = gate.run(h.task(3))
    h.release(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.started).toEqual([1, 3])
    h.release(3)
    expect(await Promise.all([first, next])).toEqual([1, 3])
  })

  it('drops a waiting request whose caller went away, and refuses one already cancelled', async () => {
    const gate = new Gate({ concurrency: 1, maxQueued: 5, maxWaitMs: 60_000 })
    const h = harness()
    const first = gate.run(h.task(1))
    const caller = new AbortController()
    const abandoned = gate.run(h.task(2), caller.signal)
    const third = gate.run(h.task(3))
    caller.abort()
    await expect(abandoned).rejects.toMatchObject({ code: 'GIT_BUSY' })
    await expect(gate.run(h.task(4), caller.signal)).rejects.toMatchObject({ code: 'GIT_BUSY' })
    h.release(1)
    await tick()
    h.release(3)
    expect(await Promise.all([first, third])).toEqual([1, 3])
    expect(h.started).toEqual([1, 3])
  })

  it('frees the slot of a task that fails', async () => {
    const gate = new Gate({ concurrency: 1, maxQueued: 5, maxWaitMs: 60_000 })
    await expect(gate.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await gate.run(() => Promise.resolve('next'))).toBe('next')
  })
})

describe('readFileContents under a burst', () => {
  let restoreGit: () => void
  let dir: string

  beforeAll(() => {
    restoreGit = isolateGit()
    dir = makeTempDir('halo-git-gate-')
    spaces.set('s', dir)
    const repo = initRepo(dir)
    for (let i = 0; i < 8; i++) repo.write(`f${i}.txt`, `old ${i}\n`)
    repo.commitAll('base')
    for (let i = 0; i < 8; i++) repo.write(`f${i}.txt`, `new ${i}\n`)
  })
  afterAll(() => {
    restoreGit()
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers what fits in the line, refuses the rest as GIT_BUSY, and serves again afterwards', async () => {
    const list = await getChangeList('s', dir, { kind: 'uncommitted' })
    const request = (i: number) => ({ scope: list.scope, beforeRevision: list.beforeRevision, path: `f${i % 8}.txt` })
    const outcomes = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => readFileContents('s', dir, request(i))))

    const answered = outcomes.flatMap((outcome, i) => (outcome.status === 'fulfilled' ? [[i, outcome.value] as const] : []))
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected')
    // 3 running + 32 waiting.
    expect(answered).toHaveLength(35)
    for (const [i, contents] of answered) expect(contents).toMatchObject({ before: `old ${i % 8}\n`, after: `new ${i % 8}\n` })
    expect(refused).toHaveLength(25)
    for (const outcome of refused) expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'GIT_BUSY' })

    expect(await readFileContents('s', dir, request(0))).toMatchObject({ after: 'new 0\n' })
  })
})
