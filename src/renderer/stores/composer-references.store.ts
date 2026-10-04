/**
 * Composer references — the cards waiting in a composer to go out with its
 * next message, in memory only (like the text draft).
 *
 * Keyed by the composer's draft key (the conversation id). The order of a
 * list is the number every surface shows, so removing a card renumbers the
 * rest. Every reference is bounded by the shared `normalizeReference` when it
 * enters, and again when its note changes.
 *
 * `target` is the composer beside the canvas — where a selection made in the
 * canvas or the chat goes. The page that places a chat beside the canvas
 * registers it, not the composer itself: the composer unmounts while the
 * canvas is maximized, and adding must keep working then.
 */

import { create } from 'zustand'
import { normalizeReference } from '../../shared/content-reference'
import { REFERENCE_LIMITS, type ContentReference } from '../../shared/types/content-reference'

/** A reference before it has an id; the store assigns one. */
export type ReferenceDraft = Omit<ContentReference, 'id'>

export interface ReferenceTarget {
  /** Draft key of the composer beside the canvas. */
  key: string
  /** Its conversation's title, for the notice shown when the composer is out of sight. */
  title: string
  /** Whether that composer is on screen (not behind a maximized or full-screen canvas). */
  visible: boolean
  /** Brings the composer on screen. */
  reveal: () => void
}

export interface AddReferencesResult {
  added: ContentReference[]
  /** Set when some drafts were left out because the message is full. */
  refused: 'limit' | null
}

/**
 * Asks the composer with `key` to show that cards arrived (its counts bump)
 * and, with `focus: 'text'`, to take the caret. The composer clears it once
 * handled, so a composer that mounts later still receives it.
 */
export interface ComposerSignal {
  key: string
  seq: number
  focus: 'text' | 'none'
}

interface ComposerReferencesState {
  drafts: ReadonlyMap<string, readonly ContentReference[]>
  target: ReferenceTarget | null
  signal: ComposerSignal | null

  setTarget: (target: ReferenceTarget | null) => void
  /** Appends in order. A path already attached is not attached twice. */
  add: (key: string, drafts: readonly ReferenceDraft[]) => AddReferencesResult
  updateNote: (key: string, id: string, note: string) => void
  remove: (key: string, id: string) => void
  /** Removes several at once; the returned function puts them back where they were. */
  removeMany: (key: string, ids: readonly string[]) => () => void
  /** Removes and returns the list, for sending. */
  take: (key: string) => ContentReference[]
  /** Puts back a list `take` returned whose send failed, ahead of anything added since. */
  restore: (key: string, references: readonly ContentReference[]) => void
  signalComposer: (key: string, focus: ComposerSignal['focus']) => void
  /** Clears the signal with `seq` once the composer handled it. */
  consumeSignal: (seq: number) => void
}

const EMPTY: readonly ContentReference[] = []

let idSeq = 0
// Unique within a message is all an id needs; randomUUID is missing on a
// remote client served over plain HTTP.
function nextId(): string {
  idSeq += 1
  return `ref-${Date.now().toString(36)}-${idSeq.toString(36)}`
}

function withList(
  drafts: ReadonlyMap<string, readonly ContentReference[]>,
  key: string,
  list: readonly ContentReference[],
): ReadonlyMap<string, readonly ContentReference[]> {
  const next = new Map(drafts)
  if (list.length > 0) next.set(key, list)
  else next.delete(key)
  return next
}

let signalSeq = 0

export const useComposerReferencesStore = create<ComposerReferencesState>((set, get) => ({
  drafts: new Map(),
  target: null,
  signal: null,

  setTarget: (target) => {
    const current = get().target
    if (current === target) return
    if (current && target
      && current.key === target.key
      && current.title === target.title
      && current.visible === target.visible
      && current.reveal === target.reveal) return
    set({ target })
  },

  add: (key, drafts) => {
    const list = get().drafts.get(key) ?? EMPTY
    const attachedPaths = new Set(list.flatMap(ref => (ref.source.kind === 'path' ? [ref.source.path] : [])))
    const added: ContentReference[] = []
    let refused: AddReferencesResult['refused'] = null
    for (const draft of drafts) {
      if (draft.source.kind === 'path') {
        if (attachedPaths.has(draft.source.path)) continue
        attachedPaths.add(draft.source.path)
      }
      if (list.length + added.length >= REFERENCE_LIMITS.maxPerMessage) {
        refused = 'limit'
        break
      }
      added.push(normalizeReference({ ...draft, id: nextId() }))
    }
    if (added.length > 0) set({ drafts: withList(get().drafts, key, [...list, ...added]) })
    return { added, refused }
  },

  updateNote: (key, id, note) => {
    const list = get().drafts.get(key)
    const index = list?.findIndex(ref => ref.id === id) ?? -1
    if (!list || index < 0) return
    const updated = normalizeReference({ ...list[index], note })
    if (updated.note === list[index].note) return
    const next = list.slice()
    next[index] = updated
    set({ drafts: withList(get().drafts, key, next) })
  },

  remove: (key, id) => {
    const list = get().drafts.get(key)
    if (!list?.some(ref => ref.id === id)) return
    set({ drafts: withList(get().drafts, key, list.filter(ref => ref.id !== id)) })
  },

  removeMany: (key, ids) => {
    const previous = get().drafts.get(key) ?? EMPTY
    const removed = new Set(ids.filter(id => previous.some(ref => ref.id === id)))
    if (removed.size === 0) return () => {}
    set({ drafts: withList(get().drafts, key, previous.filter(ref => !removed.has(ref.id))) })
    return () => {
      // Cards still there keep their current note; cards added since come after the restored ones.
      const current = get().drafts.get(key) ?? EMPTY
      const now = new Map(current.map(ref => [ref.id, ref]))
      const before = new Set(previous.map(ref => ref.id))
      const restored = previous.flatMap(ref => (removed.has(ref.id) ? [ref] : now.has(ref.id) ? [now.get(ref.id)!] : []))
      const merged = [...restored, ...current.filter(ref => !before.has(ref.id))]
      set({ drafts: withList(get().drafts, key, merged.slice(0, REFERENCE_LIMITS.maxPerMessage)) })
    }
  },

  take: (key) => {
    const list = get().drafts.get(key)
    if (!list) return []
    set({ drafts: withList(get().drafts, key, EMPTY) })
    return list.slice()
  },

  restore: (key, references) => {
    if (references.length === 0) return
    const current = get().drafts.get(key) ?? EMPTY
    const restoredIds = new Set(references.map(ref => ref.id))
    const merged = [...references, ...current.filter(ref => !restoredIds.has(ref.id))]
    set({ drafts: withList(get().drafts, key, merged.slice(0, REFERENCE_LIMITS.maxPerMessage)) })
  },

  signalComposer: (key, focus) => {
    signalSeq += 1
    set({ signal: { key, seq: signalSeq, focus } })
  },

  consumeSignal: (seq) => {
    if (get().signal?.seq === seq) set({ signal: null })
  },
}))

/** The cards waiting in the composer with `key`; the same empty array when there are none. */
export function useComposerReferences(key: string | undefined): readonly ContentReference[] {
  return useComposerReferencesStore(state => (key ? state.drafts.get(key) ?? EMPTY : EMPTY))
}

/** The cards waiting in the composer beside the canvas. */
export function useTargetReferences(): readonly ContentReference[] {
  return useComposerReferencesStore(state => (state.target ? state.drafts.get(state.target.key) ?? EMPTY : EMPTY))
}

/** Non-reactive read of the same list, for code outside React. */
export function getTargetReferences(): readonly ContentReference[] {
  const { target, drafts } = useComposerReferencesStore.getState()
  return target ? drafts.get(target.key) ?? EMPTY : EMPTY
}

/** The reference `id` in whichever composer holds it, with that composer's key. */
export function findReference(drafts: ReadonlyMap<string, readonly ContentReference[]>, id: string): { key: string; reference: ContentReference } | null {
  for (const [key, list] of drafts) {
    const reference = list.find(ref => ref.id === id)
    if (reference) return { key, reference }
  }
  return null
}
