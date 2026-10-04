/**
 * A comment card inside an editor: the React side of the CodeMirror block
 * widget. Each card is its own small React root in the widget's element; it
 * reads the comment from the composer store and what is being typed from
 * `comment-edits`, so typing and saving update it in place — the editor is
 * never asked to rebuild the widget for that.
 */

import { createRoot, type Root } from 'react-dom/client'
import { useTranslation } from '../../../i18n'
import { useComposerReferencesStore, type ReferenceDraft } from '../../../stores/composer-references.store'
import { CommentCard } from '../CommentCard'
import { commentHeader } from '../reference-display'

export interface InlineCommentProps {
  /** The reference's id, or a new comment's id. */
  id: string
  /** A new comment: what it will point at. */
  draft?: ReferenceDraft
  ghost: boolean
  /** A new comment finished: saved with its text, or discarded (null). */
  onNewDone?: (note: string | null) => void
}

function InlineComment({ id, draft, ghost, onNewDone }: InlineCommentProps) {
  const { t } = useTranslation()
  const reference = useComposerReferencesStore(state => (state.target ? state.drafts.get(state.target.key)?.find(ref => ref.id === id) : undefined))

  if (draft) {
    return (
      <CommentCard
        id={id}
        header={commentHeader(draft, t)}
        note=""
        ghost={ghost}
        autoFocus={!ghost}
        onSave={note => onNewDone?.(note)}
        onDiscard={() => onNewDone?.(null)}
      />
    )
  }
  if (!reference?.note) return null
  const save = (note: string) => {
    const { target, updateNote } = useComposerReferencesStore.getState()
    if (target) updateNote(target.key, id, note)
  }
  const remove = () => {
    const { target, remove: removeReference } = useComposerReferencesStore.getState()
    if (target) removeReference(target.key, id)
  }
  return <CommentCard id={id} header={commentHeader(reference, t)} note={reference.note} ghost={ghost} onSave={save} onDelete={remove} />
}

const roots = new WeakMap<HTMLElement, Root>()

export function renderInlineComment(container: HTMLElement, props: InlineCommentProps): void {
  let root = roots.get(container)
  if (!root) {
    root = createRoot(container)
    roots.set(container, root)
  }
  root.render(<InlineComment {...props} />)
}

export function unmountInlineComment(container: HTMLElement): void {
  const root = roots.get(container)
  if (!root) return
  roots.delete(container)
  // The editor may destroy the widget while React is rendering (an update inside an event handler).
  queueMicrotask(() => root.unmount())
}
