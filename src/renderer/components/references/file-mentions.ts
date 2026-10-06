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

/**
 * Characters a mentioned path may contain. Code is ASCII, so any character beyond it (CJK, accents,
 * full-width brackets) may belong to a name; ASCII spaces, quotes and parentheses mean it is not one.
 */
const PATH_CHARS = /^[\w.\-/\\@+~\u{80}-\u{10FFFF}]+$/u
/** The last path segment names a file: `name.ext`, a dotfile, or a well-known extensionless name. */
const FILE_NAME = /(^|[/\\])(?:[\w\-@+~\u{80}-\u{10FFFF}][\w\-@+~.\u{80}-\u{10FFFF}]*\.\w{1,12}|\.[\w\u{80}-\u{10FFFF}][\w.\-\u{80}-\u{10FFFF}]*|Makefile|Dockerfile|Jenkinsfile|Gemfile|Rakefile|LICENSE)$/u
/** Never part of a name: whitespace other than the plain space, and invisible characters such as bidi controls. */
const HIDDEN_CHARS = /[^\S ]|\p{C}/u
/** `:line`, `:line:column`, `:line-line`. */
const LINE_SUFFIX = /:(\d{1,7})(?::\d{1,5})?(?:-(\d{1,7}))?$/
const MAX_MENTION_CHARS = 400
const LINK_PATH_CHARS = /^[\w.\-/\\@+~ ()\u{80}-\u{10FFFF}]+$/u
const LINK_FILE_NAME = /(^|[/\\])(?:[\w\-@+~ ()\u{80}-\u{10FFFF}][\w\-@+~. ()\u{80}-\u{10FFFF}]*\.\w{1,12}|\.[\w\u{80}-\u{10FFFF}][\w.\-\u{80}-\u{10FFFF}]*|Makefile|Dockerfile|Jenkinsfile|Gemfile|Rakefile|LICENSE)$/u

export function detectFileMention(raw: string): FileMention | null {
  return parseFilePath(raw.trim(), PATH_CHARS, FILE_NAME)
}

function parseFilePath(text: string, pathChars: RegExp, fileName: RegExp): FileMention | null {
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
  if (!rest || rest.includes(':') || HIDDEN_CHARS.test(rest) || !pathChars.test(rest) || !fileName.test(rest)) return null
  // A bare `name.ext` without a folder is still a mention; a dotted identifier like `obj.method` is
  // filtered out by the existence check, never by guessing here.
  return range ? { path, range } : { path }
}

/** A Markdown destination, not a URL: decoding never grants access to the resulting path. */
export function detectFileLink(href: string): FileMention | null {
  if (!href || href.length > MAX_MENTION_CHARS * 3 || /[?#]/.test(href)) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(href)
  } catch {
    return null
  }
  if (decoded.length > MAX_MENTION_CHARS || /[\u0000-\u001f\u007f?#]/.test(decoded)) return null
  return parseFilePath(decoded, LINK_PATH_CHARS, LINK_FILE_NAME)
}

// ============================================
// Marking mentions in the rendered tree
// ============================================

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  data?: Record<string, unknown>
  children?: HastNode[]
}

/** Original file target on an inline-code mention or an inert named-link span. */
export const FILE_MENTION_PROPERTY = 'dataFileMention'

function textOf(node: HastNode): string | null {
  if (!node.children || node.children.length !== 1) return null
  const child = node.children[0]
  return child.type === 'text' ? child.value ?? null : null
}

function mark(node: HastNode, insidePre: boolean): void {
  if (node.tagName === 'a' || node.properties?.[FILE_MENTION_PROPERTY]) return
  if (node.type === 'element' && node.tagName === 'code' && !insidePre) {
    const text = textOf(node)
    if (text && detectFileMention(text)) node.properties = { ...node.properties, [FILE_MENTION_PROPERTY]: text }
    return
  }
  const pre = insidePre || (node.type === 'element' && node.tagName === 'pre')
  for (const child of node.children ?? []) mark(child, pre)
}

const FILE_LINK_DATA = 'haloFileLink'

/** Runs after raw HTML parsing, before sanitization can discard a Windows drive path. */
export function rehypeLocalFileLinks() {
  const convert = (node: HastNode): void => {
    if (node.tagName === 'a' && typeof node.properties?.href === 'string') {
      const href = node.properties.href
      if (detectFileLink(href)) {
        node.tagName = 'span'
        node.properties = { title: href }
        node.data = { [FILE_LINK_DATA]: href }
      }
    }
    for (const child of node.children ?? []) convert(child)
  }
  return convert
}

/** Sanitization retains internal node data, never untrusted HTML data attributes. */
export function rehypeRestoreFileLinks() {
  const restore = (node: HastNode): void => {
    const href = node.data?.[FILE_LINK_DATA]
    if (node.tagName === 'span' && typeof href === 'string' && detectFileLink(href)) {
      node.properties = { ...node.properties, [FILE_MENTION_PROPERTY]: href }
      delete node.data?.[FILE_LINK_DATA]
    }
    for (const child of node.children ?? []) restore(child)
  }
  return restore
}

/** Rehype plugin: marks inline code that looks like a file mention. Fenced code is never marked. */
export function rehypeFileMentions() {
  return (tree: HastNode) => {
    mark(tree, false)
  }
}
