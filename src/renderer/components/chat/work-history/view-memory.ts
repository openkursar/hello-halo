/**
 * What the person opened in each reply's work — the work itself, and the
 * stretches and steps inside it — kept by the transcript rather than by the
 * components that draw it. A running reply is replaced by its saved form when
 * it ends, and rows leave and re-enter the page as it scrolls; neither should
 * fold away what the person chose to read.
 *
 * Writes go straight into the memory (no re-render of anything else); a
 * component reads it once, when it mounts.
 */

import { createContext, createElement, useContext, useRef, useState, type ReactNode } from 'react'

export interface WorkViewState {
  /** The work opened or folded by the person; unset until they choose. */
  open?: boolean
  /** Stretches (`group:<first step id>`) and steps (step id) opened or closed inside it. */
  steps: Map<string, boolean>
}

/** The running reply's key until it is saved. */
export const LIVE_WORK = 'live'

export class WorkViewMemory {
  private readonly replies = new Map<string, WorkViewState>()
  /** The saved reply whose view was carried over from the running one, until the next turn. */
  private carried: string | null = null

  /** The view of `key`'s work, created on first use. */
  view(key: string): WorkViewState {
    let state = this.replies.get(key)
    if (!state) {
      state = { steps: new Map() }
      this.replies.set(key, state)
    }
    return state
  }

  /** Whether the person opened `key`'s work. */
  isOpen(key: string): boolean {
    return this.replies.get(key)?.open === true
  }

  /** The running reply was saved as `replyId`: what was opened in it stays opened there. */
  settle(replyId: string): void {
    const live = this.replies.get(LIVE_WORK)
    this.replies.delete(LIVE_WORK)
    if (live && (live.open !== undefined || live.steps.size > 0)) {
      this.replies.set(replyId, live)
      this.carried = replyId
    }
  }

  /**
   * Whether `replyId` is the reply that just finished with its work left open:
   * until its saved steps are read, the steps it streamed can stand in for them.
   */
  carriedOpen(replyId: string): boolean {
    return this.carried === replyId && this.isOpen(replyId)
  }

  /** A new turn starts with its work as first drawn. */
  startTurn(): void {
    this.replies.delete(LIVE_WORK)
    this.carried = null
  }
}

const MemoryContext = createContext<WorkViewMemory | null>(null)
const ScopeContext = createContext<WorkViewState | null>(null)

export function WorkViewMemoryProvider({ memory, children }: { memory: WorkViewMemory; children: ReactNode }) {
  return createElement(MemoryContext.Provider, { value: memory }, children)
}

/** The transcript's memory, or null outside one (a trace view): then nothing is remembered. */
export function useWorkViewMemory(): WorkViewMemory | null {
  return useContext(MemoryContext)
}

/** What the steps drawn here remember, if anything. */
export function useWorkViewScope(): WorkViewState | null {
  return useContext(ScopeContext)
}

/** Steps drawn inside it remember their open state in `view`. */
export function WorkViewScope({ view, children }: { view: WorkViewState | null; children: ReactNode }) {
  return createElement(ScopeContext.Provider, { value: view }, children)
}

/**
 * An open state that starts from what the person last chose here, and writes
 * through to it. Every choice redraws, even one equal to the state held: what
 * is shown can also depend on choices made inside (see OperationGroup).
 */
export function useRememberedOpen(id: string, fallback: boolean): [boolean, (open: boolean) => void] {
  const view = useContext(ScopeContext)
  const [state, setState] = useState(() => ({ open: view?.steps.get(id) ?? fallback }))
  const set = (next: boolean) => {
    view?.steps.set(id, next)
    setState({ open: next })
  }
  return [state.open, set]
}

/** The work's own open state, remembered in `view` when there is one. */
export function useWorkOpen(view: WorkViewState | null, fallback: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => view?.open ?? fallback)
  const set = (next: boolean) => {
    if (view) view.open = next
    setOpen(next)
  }
  return [open, set]
}

/**
 * Follows a transcript's turns for its memory. While a turn runs its work is
 * remembered as `LIVE_WORK`; once the turn ends and its saved reply appears
 * (the latest reply is no longer the one before the turn), that view moves to
 * the reply. A turn that saved no reply leaves nothing to move.
 */
export class TranscriptWorkView {
  readonly memory = new WorkViewMemory()
  private live: boolean
  private before: string | undefined
  private ending = false

  constructor(live: boolean, latestReplyId: string | undefined) {
    this.live = live
    this.before = latestReplyId
  }

  /** Called on every render, before the rows that read the memory mount. */
  observe(live: boolean, latestReplyId: string | undefined): WorkViewMemory {
    if (live && !this.live) {
      this.memory.startTurn()
      this.before = latestReplyId
      this.ending = false
    } else if (!live && this.live) {
      this.ending = true
    }
    this.live = live
    if (this.ending && latestReplyId && latestReplyId !== this.before) {
      this.memory.settle(latestReplyId)
      this.ending = false
    }
    return this.memory
  }
}

/** A transcript's memory, kept across its renders; see TranscriptWorkView. */
export function useTranscriptWorkView(live: boolean, latestReplyId: string | undefined): WorkViewMemory {
  const follower = useRef<TranscriptWorkView | null>(null)
  follower.current ??= new TranscriptWorkView(live, latestReplyId)
  return follower.current.observe(live, latestReplyId)
}
