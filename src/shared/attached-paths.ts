/**
 * Local files and folders the user attached to a message, by absolute path.
 *
 * On the desktop a local file needs no upload: the agent reads it where it is.
 * The composer shows attachments as chips and appends this block on send, so
 * the transcript, what the model reads, and what a later `conversation_read`
 * sees are the same text. The transcript renderer splits the block back off
 * to show the chips again.
 *
 * Shape (always the message's tail; a folder keeps a trailing separator):
 *
 *   Summarize these
 *
 *   <attached_paths>
 *   /Users/me/Reports/q3.pdf
 *   /Users/me/Projects/site/
 *   "/Users/me/odd\nname.txt"
 *   </attached_paths>
 *
 * One absolute path per line, written as is. A path that cannot be a line on
 * its own (a line break is legal in a POSIX file name) is written as a JSON
 * string instead; a raw absolute path never starts with `"`, so the two never
 * collide and every path round-trips.
 *
 * Parsing is by whole lines from the end: the last line must be the closing
 * tag, the nearest line above equal to the opening tag starts the block, and
 * every line between must decode to an absolute path — otherwise the whole
 * message is text. So text or a file name that merely contains a tag never
 * produces an attachment or loses text.
 *
 * Lives in `shared/` because the composer writes this form and every surface
 * that shows a user message reads it; a second copy of the format drifts.
 */

export interface AttachedPath {
  path: string
  isDirectory: boolean
}

/**
 * One entry picked in the native file dialog. A supported image small enough
 * to attach carries its bytes: the renderer cannot read the disk, and an image
 * is better seen by the model than read by path.
 */
export interface PickedLocalEntry extends AttachedPath {
  image?: { data: string; mediaType: string; size: number }
}

const OPEN_TAG = '<attached_paths>'
const CLOSE_TAG = '</attached_paths>'

/** An absolute local path: POSIX, drive-letter, or UNC. Anything else is not a local file. */
export function canAttachPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function encodeLine(path: string): string {
  return /[\r\n]/.test(path) || path.startsWith('"') ? JSON.stringify(path) : path
}

function decodeLine(line: string): string | null {
  if (!line.startsWith('"')) return canAttachPath(line) ? line : null
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'string' && canAttachPath(value) ? value : null
  } catch {
    return null
  }
}

function endsWithSeparator(path: string): boolean {
  return path.endsWith('/') || path.endsWith('\\')
}

function withTrailingSeparator(path: string): string {
  if (endsWithSeparator(path)) return path
  return path + (path.includes('\\') && !path.includes('/') ? '\\' : '/')
}

/** The last path segment, for display. */
export function attachedPathName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]/)
  return segments[segments.length - 1] || trimmed || path
}

/** Every path given is written; callers admit only paths that pass `canAttachPath`. */
export function appendAttachedPaths(text: string, paths: AttachedPath[]): string {
  if (paths.length === 0) return text
  const lines = paths.map(p => encodeLine(p.isDirectory ? withTrailingSeparator(p.path) : p.path))
  const block = `${OPEN_TAG}\n${lines.join('\n')}\n${CLOSE_TAG}`
  return text ? `${text}\n\n${block}` : block
}

/** Splits a message into its text and the paths attached to it. */
export function splitAttachedPaths(content: string): { text: string; paths: AttachedPath[] } {
  const lines = content.replace(/\s+$/, '').split('\n')
  if (lines.length < 3 || lines[lines.length - 1] !== CLOSE_TAG) return { text: content, paths: [] }

  const paths: AttachedPath[] = []
  for (let i = lines.length - 2; i >= 0; i -= 1) {
    if (lines[i] === OPEN_TAG) {
      if (paths.length === 0) break
      const text = lines.slice(0, i).join('\n').replace(/\n+$/, '')
      return { text, paths: paths.reverse() }
    }
    const path = decodeLine(lines[i])
    if (path === null) break
    paths.push({ path, isDirectory: endsWithSeparator(path) })
  }
  return { text: content, paths: [] }
}
