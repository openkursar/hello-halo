/**
 * Unit Tests: services/agent/dsh — normalizer against a REAL runtime capture.
 *
 * The other dsh tests run on synthetic fixtures built from the harness type
 * definitions. This one replays `__fixtures__/runtime-notifications.jsonl`,
 * recorded from the bundled runtime by `runtime-e2e.test.ts`
 * (`DSH_E2E=1 DSH_E2E_CAPTURE=1`), so a drift between what the harness really
 * emits and what the normalizer expects fails here first. Re-record it after
 * upgrading dsh.
 *
 * The capture is one turn: reasoning and a `bash` call in the first model
 * call, the tool's result, then a text reply.
 */

import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { DshEventNormalizer } from '../../../../../src/main/services/agent/dsh/event-normalizer'
import type { DshNotification } from '../../../../../src/main/services/agent/dsh/types'

const FIXTURE = path.resolve(
  __dirname,
  '../../../../../src/main/services/agent/dsh/__fixtures__/runtime-notifications.jsonl'
)

function loadNotifications(): DshNotification[] {
  return readFileSync(FIXTURE, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((frame) => typeof frame.method === 'string')
    .map((frame) => ({ method: frame.method, payload: frame.params }))
}

/** The session id the capture was recorded under. */
const SESSION = (loadNotifications()[0].payload as { sessionId: string }).sessionId

/** Replay the capture the way the session adapter drives one turn. */
function replay(): { frames: Record<string, any>[]; turns: number } {
  const normalizer = new DshEventNormalizer({
    sessionId: SESSION,
    model: 'deepseek-v4',
    includePartialMessages: true,
    newId: (prefix) => `${prefix}-fixed`,
  })

  const frames: Record<string, any>[] = []
  let turns = 0
  let open = false

  for (const notification of loadNotifications()) {
    if (!open) {
      frames.push(...normalizer.beginTurn())
      open = true
    }
    frames.push(...normalizer.handle(notification))
    if (normalizer.isOwnIdle(notification)) {
      frames.push(...normalizer.endTurn())
      turns += 1
      open = false
    }
  }

  return { frames, turns }
}

describe('dsh normalizer — real runtime capture', () => {
  it('produces the per-turn envelope contract for every turn', () => {
    const { frames, turns } = replay()

    expect(turns).toBeGreaterThanOrEqual(1)
    expect(frames.filter((f) => f.type === 'system' && f.subtype === 'init')).toHaveLength(turns)
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(turns)

    const first = frames[0]
    expect(first.type).toBe('system')
    expect(first.subtype).toBe('init')
    expect(frames[frames.length - 1].type).toBe('result')
  })

  it('emits the tool_use aggregate before its tool_result', () => {
    const { frames } = replay()

    const toolUse = frames.find(
      (f) => f.type === 'assistant'
        && f.message?.content?.some((block: any) => block.type === 'tool_use')
    )
    expect(toolUse).toBeDefined()

    const toolUseId = toolUse!.message.content.find((b: any) => b.type === 'tool_use').id
    const resultIndex = frames.findIndex(
      (f) => f.type === 'user'
        && f.message?.content?.some((block: any) => block.tool_use_id === toolUseId)
    )

    expect(resultIndex).toBeGreaterThan(frames.indexOf(toolUse!))
  })

  it('streams assistant text and reasoning as token-level deltas', () => {
    const { frames } = replay()

    const deltas = (type: string) => frames.filter(
      (f) => f.type === 'stream_event' && f.event?.delta?.type === type
    )
    expect(deltas('text_delta').length).toBeGreaterThan(0)
    expect(deltas('thinking_delta').length).toBeGreaterThan(0)
    expect(deltas('input_json_delta').length).toBeGreaterThan(0)
  })

  it('carries the tool output and a successful result', () => {
    const { frames } = replay()

    const toolResult = frames.find((f) => f.type === 'user')
    expect(toolResult?.message.content[0]).toMatchObject({ content: 'dsh-shell-42\n', is_error: false })

    const result = frames[frames.length - 1]
    expect(result).toMatchObject({ type: 'result', subtype: 'success', is_error: false })
    expect(result.result).toBe('Halo and dsh are connected.')
  })

  it('renders neither the persona nor runtime-context snapshots', () => {
    const rendered = JSON.stringify(replay().frames)
    expect(rendered).not.toContain('Current runtime context')
    expect(rendered).not.toContain('You are a helpful assistant.')
  })

  it('never emits a frame for a session it does not own', () => {
    const foreign = new DshEventNormalizer({
      sessionId: 'not-the-captured-session',
      model: 'deepseek-v4',
      includePartialMessages: true,
    })

    const frames = loadNotifications().flatMap((n) => foreign.handle(n))
    expect(frames).toHaveLength(0)
  })
})
