/**
 * Agent Module - Changes to a running turn's thoughts, for readers that poll
 *
 * A view that polls a running turn (the team workbench) asks for the thoughts
 * changed since its previous read instead of the whole turn every few seconds.
 *
 * A live thought is changed in place (a tool's result arrives, a background
 * task reports progress) and every such change is announced as an
 * `agent:thought` / `agent:thought-delta` event naming it — the live chat view
 * depends on exactly those events — so marking thoughts from them covers what
 * changes. The rare change made without an event (a result drained after a
 * stop) is marked by its writer through `noteThoughtChanged`.
 *
 * Nothing is tracked until a reader first asks; marks live with the turn's
 * SessionState and go with it.
 */

import { randomUUID } from 'crypto'
import { onAgentEvent } from './events'
import type { SessionState, Thought } from './types'

interface Marks {
  /** Identifies this turn in a reader's token. */
  turn: string
  revision: number
  byId: Map<string, number>
}

const marksByState = new WeakMap<SessionState, Marks>()
/** The turn being marked per conversation; held weakly so a finished turn can go. */
const marking = new Map<string, WeakRef<SessionState>>()
let listening = false

function mark(state: SessionState, thoughtId: unknown): void {
  const marks = marksByState.get(state)
  if (marks && typeof thoughtId === 'string') marks.byId.set(thoughtId, ++marks.revision)
}

function listen(): void {
  if (listening) return
  listening = true
  onAgentEvent(({ channel, conversationId, data }) => {
    if (channel !== 'agent:thought' && channel !== 'agent:thought-delta') return
    const ref = marking.get(conversationId)
    if (!ref) return
    const state = ref.deref()
    if (!state) {
      marking.delete(conversationId)
      return
    }
    mark(state, channel === 'agent:thought' ? (data.thought as Thought | undefined)?.id : data.thoughtId)
  })
}

/** A change to a live thought that no event announces. */
export function noteThoughtChanged(state: SessionState, thoughtId: string): void {
  mark(state, thoughtId)
}

export interface LiveThoughtsRead {
  /** All thoughts, or with `thoughtsDelta` only the changed ones. */
  thoughts: Thought[]
  /** Pass back as `since` on the next read. */
  thoughtsRevision: string
  /** Present when `thoughts` are only those changed: their places in the whole list, and its length. */
  thoughtsDelta?: { total: number; at: number[] }
}

/**
 * The turn's thoughts for a polling reader: all of them on its first read (or
 * when its token is from another turn), afterwards those changed or added
 * since the read that gave `since`.
 */
export function readLiveThoughts(conversationId: string, state: SessionState, since: string): LiveThoughtsRead {
  listen()
  let marks = marksByState.get(state)
  if (!marks) {
    marks = { turn: randomUUID().slice(0, 8), revision: 0, byId: new Map() }
    marksByState.set(state, marks)
  }
  if (marking.get(conversationId)?.deref() !== state) {
    for (const [id, ref] of marking) if (!ref.deref()) marking.delete(id)
    marking.set(conversationId, new WeakRef(state))
  }

  const thoughts = state.thoughts
  const thoughtsRevision = `${marks.turn}:${marks.revision}:${thoughts.length}`
  const match = /^([^:]+):(\d+):(\d+)$/.exec(since)
  if (!match || match[1] !== marks.turn || Number(match[3]) > thoughts.length) {
    return { thoughts: [...thoughts], thoughtsRevision }
  }
  const revision = Number(match[2])
  const held = Number(match[3])
  const at: number[] = []
  const changed: Thought[] = []
  thoughts.forEach((thought, index) => {
    if (index >= held || (marks!.byId.get(thought.id) ?? 0) > revision) {
      at.push(index)
      changed.push(thought)
    }
  })
  return { thoughts: changed, thoughtsRevision, thoughtsDelta: { total: thoughts.length, at } }
}
