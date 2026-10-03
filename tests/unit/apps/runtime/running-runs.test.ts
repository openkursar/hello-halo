/**
 * Running-run registry: per-app counts, busy transitions only on the first run
 * and after the last one, and abort scoping.
 */

import { describe, it, expect, vi } from 'vitest'
import { RunningRuns } from '../../../../src/main/apps/runtime/running-runs'

describe('RunningRuns', () => {
  it('reports an app busy on its first run and idle after its last', () => {
    const changes: Array<[string, boolean]> = []
    const runs = new RunningRuns((appId, busy) => changes.push([appId, busy]))

    runs.add('a', 'a:1', new AbortController())
    runs.add('a', 'a:2', new AbortController())
    runs.add('b', 'b:3', new AbortController())
    expect(runs.count('a')).toBe(2)
    runs.remove('a', 'a:1')
    runs.remove('a', 'a:1')
    runs.remove('a', 'a:2')

    expect(changes).toEqual([['a', true], ['b', true], ['a', false]])
    expect(runs.has('a')).toBe(false)
    expect([...runs.counts()]).toEqual([['b', 1]])
  })

  it('aborts only the named app, or everything', () => {
    const runs = new RunningRuns()
    const a = new AbortController()
    const b = new AbortController()
    runs.add('a', 'a:1', a)
    runs.add('b', 'b:1', b)

    runs.abortApp('a')
    expect([a.signal.aborted, b.signal.aborted]).toEqual([true, false])
    runs.abortAll()
    expect(b.signal.aborted).toBe(true)
  })

  it('an app prefix never matches another app', () => {
    const runs = new RunningRuns()
    runs.add('app', 'app:1', new AbortController())
    expect(runs.has('app2')).toBe(false)
    expect(runs.count('ap')).toBe(0)
  })
})
