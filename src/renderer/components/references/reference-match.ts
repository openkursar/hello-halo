/**
 * Whether a pending reference points into the content a surface shows, so
 * the surface draws its number there. A diff side is matched with its compare
 * label: the same file under another compare scope is different content.
 */

import type { ContentReferenceSource } from '../../../shared/types/content-reference'

export function sameReferenceSource(reference: ContentReferenceSource, shown: ContentReferenceSource): boolean {
  switch (shown.kind) {
    case 'file':
      return reference.kind === 'file' && reference.path === shown.path
    case 'diff':
      return reference.kind === 'diff'
        && reference.path === shown.path
        && reference.side === shown.side
        && reference.compareLabel === shown.compareLabel
    case 'message':
      // A whole-message card marks no passage.
      return reference.kind === 'message'
        && !reference.whole
        && reference.conversationId === shown.conversationId
        && reference.messageId === shown.messageId
    case 'terminal':
      return reference.kind === 'terminal' && !!shown.sessionId && reference.sessionId === shown.sessionId
    case 'path':
      return reference.kind === 'path' && reference.path === shown.path
  }
}
