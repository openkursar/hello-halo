/**
 * Whether the person is in the middle of typing or editing, read from where the
 * keyboard focus is at the moment it matters. Nothing is listened to or kept:
 * the AI's request to show something asks once, and the answer is only "do not
 * move the screen now".
 */

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

export function isUserTyping(doc: Pick<Document, 'activeElement' | 'body'> = document): boolean {
  const element = doc.activeElement as HTMLElement | null
  if (!element || element === doc.body) return false
  // Working in a page, a terminal or an editor of the canvas.
  if (element.tagName === 'WEBVIEW') return true
  if (element.closest?.('.xterm')) return true
  if (element.isContentEditable) return true
  // A draft in the composer (or any text field): a sent message leaves it empty.
  if (element.tagName === 'TEXTAREA') return ((element as HTMLTextAreaElement).value ?? '').trim().length > 0
  if (element.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((element as HTMLInputElement).type)) {
    return ((element as HTMLInputElement).value ?? '').trim().length > 0
  }
  return false
}
