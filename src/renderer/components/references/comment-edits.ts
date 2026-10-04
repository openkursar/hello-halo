/**
 * Comments being written or edited, by reference id — a new comment by the id
 * it has until it is saved. What has been typed lives here rather than in the
 * card, so a card an editor rebuilds (a long diff scrolled away and back, a
 * layout switch) comes back with the same text, the hidden twin that keeps a
 * side-by-side diff aligned grows with it as one types, and sending the
 * message can take whatever is still open.
 */

import { create } from 'zustand'
import { useComposerReferencesStore, type ReferenceDraft } from '../../stores/composer-references.store'
import { addReference } from './add-reference'

/** A comment not added yet: what it will point at, and the composer it will go to. */
export interface NewComment {
  draft: ReferenceDraft
  composerKey: string
}

export interface CommentEditsState {
  texts: ReadonlyMap<string, string>
  newComments: ReadonlyMap<string, NewComment>
}

export const useCommentEdits = create<CommentEditsState>(() => ({ texts: new Map(), newComments: new Map() }))

function setText(id: string, text: string | null): void {
  const texts = new Map(useCommentEdits.getState().texts)
  if (text === null) texts.delete(id)
  else texts.set(id, text)
  useCommentEdits.setState({ texts })
}

/** Opens the comment `id` for editing with `text`, unless it is already open (what was typed is kept). */
export function startEditing(id: string, text: string): void {
  if (!useCommentEdits.getState().texts.has(id)) setText(id, text)
}

export function setEditText(id: string, text: string): void {
  if (useCommentEdits.getState().texts.has(id)) setText(id, text)
}

export function stopEditing(id: string): void {
  if (useCommentEdits.getState().texts.has(id)) setText(id, null)
}

/** What is being typed for `id`, or null when it is not open. */
export function useEditText(id: string): string | null {
  return useCommentEdits(state => state.texts.get(id) ?? null)
}

let newCommentSeq = 0

/** Starts writing a comment that goes to `composerKey` once saved; returns its id. */
export function startNewComment(composerKey: string, draft: ReferenceDraft): string {
  newCommentSeq += 1
  const id = `new-comment-${newCommentSeq}`
  const newComments = new Map(useCommentEdits.getState().newComments)
  newComments.set(id, { draft, composerKey })
  useCommentEdits.setState({ newComments })
  startEditing(id, '')
  return id
}

/** Whether a new comment with text is open for the composer `composerKey` — sending would add it. */
export function hasNewCommentText(state: CommentEditsState, composerKey: string): boolean {
  for (const [id, entry] of state.newComments) {
    if (entry.composerKey === composerKey && state.texts.get(id)?.trim()) return true
  }
  return false
}

export function useHasNewCommentText(composerKey: string): boolean {
  return useCommentEdits(state => hasNewCommentText(state, composerKey))
}

/** Drops a new comment, saved or not. */
export function endNewComment(id: string): void {
  stopEditing(id)
  if (!useCommentEdits.getState().newComments.has(id)) return
  const newComments = new Map(useCommentEdits.getState().newComments)
  newComments.delete(id)
  useCommentEdits.setState({ newComments })
}

/** Saves a new comment with `note` — an empty one goes in as a plain selection — and ends it. */
export function saveNewComment(id: string, note: string): void {
  const entry = useCommentEdits.getState().newComments.get(id)
  endNewComment(id)
  if (!entry) return
  const draft = note ? { ...entry.draft, note } : entry.draft
  const store = useComposerReferencesStore.getState()
  if (store.target?.key === entry.composerKey) addReference(draft, { focusComposer: false })
  else store.add(entry.composerKey, [draft])
}

/**
 * Takes what is still open for the composer `composerKey` before its message
 * goes out — sending means the writing is done: an edited comment keeps its
 * new text, a new comment with text is added, an empty new one is dropped.
 */
export function commitCommentEdits(composerKey: string): void {
  const { texts, newComments } = useCommentEdits.getState()
  if (texts.size === 0 && newComments.size === 0) return
  const store = useComposerReferencesStore.getState()
  for (const ref of store.drafts.get(composerKey) ?? []) {
    const text = texts.get(ref.id)
    if (text === undefined) continue
    store.updateNote(composerKey, ref.id, text.trim())
    stopEditing(ref.id)
  }
  for (const [id, entry] of newComments) {
    if (entry.composerKey !== composerKey) continue
    const text = texts.get(id)?.trim() ?? ''
    if (text) store.add(composerKey, [{ ...entry.draft, note: text }])
    endNewComment(id)
  }
}
