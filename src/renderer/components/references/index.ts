/**
 * Unified references — pointing at a place in content and handing it to the
 * chat, then going back to it. The one surface other modules import from:
 *
 * - Adding: `addReference` (feedback included) — content surfaces never write
 *   the composer store directly.
 * - Adapters that make content referenceable and show pending references —
 *   highlighted, a comment also as a card under its lines or a marker in the
 *   margin: `referenceExtension` (CodeMirror, incl. both sides of a merge
 *   view), `useTextReferences` (rendered text), `attachTerminalReferences`
 *   (xterm).
 * - Going back: `revealReference`, `revealMessage`, and the helpers a viewer
 *   uses when it consumes a tab's reveal request itself.
 * - Chips: the composer's and the transcript's summary of a message's
 *   references, with the list each opens; the task card.
 * - The page layer: `ReferenceLayer`, `ConversationReferenceScope`, file links.
 *
 * Does NOT persist anything or talk to the main process about references:
 * the composer store is in memory, and sending is the chat surfaces' job.
 */

export type { ReferenceDraft } from '../../stores/composer-references.store'
export { addReference, notifyReferenceLimit } from './add-reference'
export { commitCommentEdits, useHasNewCommentText } from './comment-edits'
export { openCommentCard, openCommentCardAtComposer, openCommentCardAtTopOf } from './comment-markers'

export { referenceExtension, revealInEditor, focusCommentCard, type CodeMirrorReferenceOptions } from './adapters/codemirror'
export { useTextReferences, revealInElement, type TextReferenceOptions } from './adapters/dom-text'
export { attachTerminalReferences, revealInTerminal, terminalTopRect } from './adapters/xterm'

export { revealReference, revealMessage, revealFileAt, notifyRevealOutcome, notifyTerminalOutputMissing } from './reveal'
export { relocateLines, type LineSource, type RevealOutcome } from './relocate'

export { ComposerReferenceChips, MessageReferenceChips } from './ReferenceChips'
export { MessageTaskCard } from './MessageTaskCard'
export { referenceLabel } from './reference-display'

export { ReferenceLayer, type ReferenceLayerProps } from './ReferenceLayer'
export { ConversationReferenceScope, useConversationReferenceScope } from './conversation-scope'
export {
  FileLinkProvider,
  useFileLinkOptions,
  useFileMentionLinks,
  fileLinkHandlers,
  type FileLinkOptions,
  type FileLinkTarget,
} from './file-links'
export { rehypeFileMentions } from './file-mentions'
