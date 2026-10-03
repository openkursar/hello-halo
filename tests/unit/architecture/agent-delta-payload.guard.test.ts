/**
 * A delta event carries the increment, never the accumulated content as well:
 * every event is cloned over IPC and serialized per WebSocket client, so a
 * payload that grows with the block makes a stream quadratic in bytes. The
 * accumulated text may go out once, on the event that completes the block.
 */

import { describe, expect, it } from 'vitest'
import { listSourceFiles, readSource } from './lib/source-scan'

const DELTA_EVENT = /emitAgentEvent\(\s*'agent:(?:thought-delta|message)'/g

/** The object literal passed with each delta event, up to its closing `})`. */
function deltaPayloads(file: string): Array<{ line: number; payload: string }> {
  const source = readSource(file)
  const payloads: Array<{ line: number; payload: string }> = []
  for (const match of source.matchAll(DELTA_EVENT)) {
    const start = match.index ?? 0
    const end = source.indexOf('})', start)
    payloads.push({ line: source.slice(0, start).split('\n').length, payload: source.slice(start, end) })
  }
  return payloads
}

describe('agent delta payload guard', () => {
  it('no delta event also sends accumulated content', () => {
    const offenders = listSourceFiles('src/main').flatMap(file =>
      deltaPayloads(file)
        .filter(({ payload }) => /\bdelta\b\s*[,:}\n]/.test(payload) && /\bcontent\s*:/.test(payload))
        .map(({ line }) => `${file}:${line}`),
    )
    expect(offenders).toEqual([])
  })

  it('finds the delta events it guards', () => {
    const count = listSourceFiles('src/main/services/agent').reduce((n, file) => n + deltaPayloads(file).length, 0)
    expect(count).toBeGreaterThan(5)
  })
})
