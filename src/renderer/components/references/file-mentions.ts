/**
 * `path`, `path:12`, `path:12-18` written as inline code in an AI reply:
 * recognizing them, and marking them in the rendered tree so the renderer can
 * turn the ones that name a real file into links.
 *
 * Recognition is only a cheap pre-filter — whether the file exists (asked of
 * the main process, see file-links) is what makes a mention a link.
 */

import type { ReferenceLineRange } from '../../../shared/types/content-reference'

export interface FileMention {
  /** As written: relative to the base directory, or absolute. */
  path: string
  range?: ReferenceLineRange
}

/** Characters a mentioned path may contain; anything else (spaces, quotes, parentheses) means it is not one. */
const PATH_CHARS = /^[\w.\-/\\@+~]+$/
/** The last path segment names a file: `name.ext`, a dotfile, or a well-known extensionless name. */
const FILE_NAME = /(^|[/\\])(?:[\w\-@+~][\w\-@+~.]*\.\w{1,12}|\.\w[\w.-]*|Makefile|Dockerfile|Jenkinsfile|Gemfile|Rakefile|LICENSE)$/
/** `:line`, `:line:column`, `:line-line`. */
const LINE_SUFFIX = /:(\d{1,7})(?::\d{1,5})?(?:-(\d{1,7}))?$/
const MAX_MENTION_CHARS = 400

export function detectFileMention(raw: string): FileMention | null {
  const text = raw.trim()
  if (!text || text.length > MAX_MENTION_CHARS || text.includes('://')) return null

  let path = text
  let range: ReferenceLineRange | undefined
  const suffix = LINE_SUFFIX.exec(text)
  if (suffix) {
    path = text.slice(0, suffix.index)
    const start = Number(suffix[1])
    const end = suffix[2] ? Number(suffix[2]) : start
    if (start < 1 || end < start) return null
    range = { startLine: start, endLine: end }
  }
  // A network share or device path is never a file of the space (the main process refuses them too).
  if (/^[\\/]{2}/.test(path)) return null
  // A Windows drive (`C:\…`) is the only colon a path may keep.
  const drive = /^[A-Za-z]:[\\/]/.test(path) ? path.slice(0, 2) : ''
  const rest = path.slice(drive.length)
  if (!rest || rest.includes(':') || !PATH_CHARS.test(rest) || !FILE_NAME.test(rest)) return null
  // A bare `name.ext` without a folder is still a mention; a dotted identifier like `obj.method` is
  // filtered out by the existence check, never by guessing here.
  return range ? { path, range } : { path }
}

// ============================================
// Marking mentions in the rendered tree
// ============================================

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** Attribute (as a hast property) holding the mention's text on its inline `<code>`. */
export const FILE_MENTION_PROPERTY = 'dataFileMention'

function textOf(node: HastNode): string | null {
  if (!node.children || node.children.length !== 1) return null
  const child = node.children[0]
  return child.type === 'text' ? child.value ?? null : null
}

function mark(node: HastNode, insidePre: boolean): void {
  if (node.type === 'element' && node.tagName === 'code' && !insidePre) {
    const text = textOf(node)
    if (text && detectFileMention(text)) node.properties = { ...node.properties, [FILE_MENTION_PROPERTY]: text }
    return
  }
  const pre = insidePre || (node.type === 'element' && node.tagName === 'pre')
  for (const child of node.children ?? []) mark(child, pre)
}

/** Rehype plugin: marks inline code that looks like a file mention. Fenced code is never marked. */
export function rehypeFileMentions() {
  return (tree: HastNode) => {
    mark(tree, false)
  }
}
