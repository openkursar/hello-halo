/**
 * Ctrl+C in the terminal. On Windows and Linux, with text selected, it copies
 * that text (xterm keeps its selection to itself, so the page has nothing to
 * copy) and the selection is cleared, so the next Ctrl+C interrupts again
 * (#358). On macOS Ctrl+C always interrupts and ⌘C copies through the copy
 * command xterm already answers, as in every macOS terminal.
 */

type KeyPress = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey'>

/**
 * Whether this key press copies the selection instead of reaching the shell. A
 * selection of blank cells reads as empty and leaves the key to the shell.
 */
export function copiesSelection(e: KeyPress, isMac: boolean, selection: string): boolean {
  return !isMac && (e.ctrlKey || e.metaKey) && e.key === 'c' && selection.length > 0
}
