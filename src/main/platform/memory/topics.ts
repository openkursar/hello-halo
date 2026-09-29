/**
 * platform/memory -- Topics
 *
 * The topic wiki under `memory/topics/`: long-lived knowledge, one subject per
 * file, grouped into category folders. Every topic file opens with front matter
 * whose `description` says WHEN to read it; a category is a folder whose
 * `index.md` holds only that front matter.
 *
 * The index the agent sees is generated here from those descriptions every time
 * memory is loaded. It is never written to disk: a stored list would drift from
 * the files, and a consolidation could drop a line of it and orphan a topic.
 */

import { open, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { isNodeError } from './file-ops'

// ============================================================================
// Types
// ============================================================================

export interface TopicFile {
  kind: 'topic'
  /** Path relative to the topics root, `/`-separated */
  relPath: string
  name?: string
  description?: string
  sizeBytes: number
}

export interface TopicCategory {
  kind: 'category'
  /** Path relative to the topics root, `/`-separated, no trailing slash */
  relPath: string
  name?: string
  description?: string
  /** False when the folder has no `index.md` */
  hasIndex: boolean
  children: TopicNode[]
  /** Topic files anywhere below this folder */
  topicCount: number
}

export type TopicNode = TopicFile | TopicCategory

export interface TopicsTree {
  /** Absolute path of the topics root */
  root: string
  children: TopicNode[]
  topicCount: number
  totalBytes: number
  /** True when the walk stopped early at the entry ceiling */
  truncated: boolean
}

// ============================================================================
// Front matter
// ============================================================================

export interface TopicFrontMatter {
  name?: string
  description?: string
}

/**
 * Read `name` and `description` from a leading `---` block.
 *
 * Deliberately not a YAML parser: two flat string keys are all a topic carries,
 * and a hand-written file with a stray colon must still yield its description.
 */
export function parseTopicFrontMatter(content: string): TopicFrontMatter {
  const text = content.replace(/^\uFEFF/, '')
  const match = text.match(/^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/)
  if (!match) return {}

  const result: TopicFrontMatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description)\s*:\s*(.*)$/)
    if (!kv) continue
    const value = unquote(kv[2].trim())
    if (value) result[kv[1] as 'name' | 'description'] = value
  }
  return result
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' || first === "'") && first === last) return value.slice(1, -1).trim()
  }
  return value
}

// ============================================================================
// Scan
// ============================================================================

/** Front matter sits at the top; reading more of a large page buys nothing. */
const FRONT_MATTER_READ_BYTES = 4096

/** Bounds a pathological tree so loading memory can never stall a turn. */
const MAX_SCAN_ENTRIES = 5000
const MAX_SCAN_DEPTH = 12

const CATEGORY_INDEX = 'index.md'

async function readHead(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(FRONT_MATTER_READ_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, FRONT_MATTER_READ_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await handle.close()
  }
}

/**
 * Walk the topics root. Hidden entries are skipped; so is anything that is not
 * a markdown file or a folder.
 *
 * @returns An empty tree when the root does not exist
 */
export async function scanTopics(root: string): Promise<TopicsTree> {
  const tree: TopicsTree = { root, children: [], topicCount: 0, totalBytes: 0, truncated: false }
  let seen = 0

  async function walk(dir: string, relDir: string, depth: number): Promise<TopicNode[]> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err: unknown) {
      if (isNodeError(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return []
      throw err
    }

    const nodes: TopicNode[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      if (++seen > MAX_SCAN_ENTRIES) {
        tree.truncated = true
        break
      }
      const abs = join(dir, entry.name)
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        if (depth >= MAX_SCAN_DEPTH) {
          tree.truncated = true
          continue
        }
        const children = await walk(abs, rel, depth + 1)
        const indexPath = join(abs, CATEGORY_INDEX)
        let front: TopicFrontMatter = {}
        let hasIndex = false
        try {
          front = parseTopicFrontMatter(await readHead(indexPath))
          hasIndex = true
        } catch (err: unknown) {
          if (!(isNodeError(err) && err.code === 'ENOENT')) throw err
        }
        nodes.push({
          kind: 'category',
          relPath: rel,
          name: front.name,
          description: front.description,
          hasIndex,
          children,
          topicCount: children.reduce((n, c) => n + (c.kind === 'topic' ? 1 : c.topicCount), 0),
        })
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // A category's index.md describes the folder, it is not a topic.
        if (relDir && entry.name === CATEGORY_INDEX) continue
        const [info, head] = await Promise.all([stat(abs), readHead(abs)])
        const front = parseTopicFrontMatter(head)
        tree.totalBytes += info.size
        nodes.push({
          kind: 'topic',
          relPath: rel,
          name: front.name,
          description: front.description,
          sizeBytes: info.size,
        })
      }
    }

    // Categories first: they are the entry points of a large wiki.
    return [
      ...nodes.filter(n => n.kind === 'category'),
      ...nodes.filter(n => n.kind === 'topic'),
    ]
  }

  tree.children = await walk(root, '', 0)
  tree.topicCount = tree.children.reduce((n, c) => n + (c.kind === 'topic' ? 1 : c.topicCount), 0)
  if (tree.truncated) {
    console.warn(`[Memory] Topic scan of ${root} stopped at ${MAX_SCAN_ENTRIES} entries / depth ${MAX_SCAN_DEPTH}`)
  }
  return tree
}

/** Every topic file below `nodes`, depth-first. */
export function flattenTopics(nodes: TopicNode[]): TopicFile[] {
  const out: TopicFile[] = []
  for (const node of nodes) {
    if (node.kind === 'topic') out.push(node)
    else out.push(...flattenTopics(node.children))
  }
  return out
}

// ============================================================================
// Index rendering
// ============================================================================

/**
 * Upper bound on the rendered index. Not a limit on the wiki — only on how much
 * of it is spelled out up front; the rest is reached by entering a category or
 * searching. Past the bound, deeper levels fold into counts.
 */
export const TOPIC_INDEX_BUDGET_CHARS = 6000

interface RenderSlot {
  node: TopicNode
  depth: number
  /** For categories: how many children are listed (0 = collapsed) */
  shown: number
}

/**
 * Render the index as a markdown list, breadth-first within a character budget:
 * every top-level entry is listed, then categories are opened level by level
 * while the budget lasts. A category that does not fit opens partially, ending
 * in a `… N more` line; one that is not reached shows its topic count.
 *
 * @returns The lines, and whether anything was folded away
 */
export function renderTopicIndexLines(
  tree: TopicsTree,
  budgetChars: number = TOPIC_INDEX_BUDGET_CHARS,
  opts: { topLevelOnly?: boolean } = {}
): { lines: string[]; folded: boolean; usedChars: number } {
  const slots = new Map<TopicNode, RenderSlot>()
  let used = 0
  let folded = false

  const lineFor = (node: TopicNode, depth: number, shown: number): string => {
    const indent = '  '.repeat(depth)
    const name = baseName(node.relPath)
    if (node.kind === 'topic') {
      const desc = node.description ?? '⚠ no description — add front matter'
      return `${indent}- ${name} (${formatKB(node.sizeBytes)}) — ${desc}`
    }
    const desc = node.hasIndex
      ? (node.description ?? '⚠ index.md has no description')
      : '⚠ no index.md'
    const count = shown > 0 ? '' : ` (${node.topicCount} topics)`
    return `${indent}- ${name}/ — ${desc}${count}`
  }

  const moreLine = (cat: TopicCategory, depth: number, remaining: number): string =>
    `${'  '.repeat(depth + 1)}- … ${remaining} more in ${cat.relPath}/`

  // Top level is always listed in full; if even that overflows, it is cut with
  // a pointer to the folder rather than dropped silently.
  const top = tree.children
  let topShown = 0
  for (const node of top) {
    const cost = lineFor(node, 0, 0).length + 1
    if (used + cost > budgetChars && topShown > 0) break
    slots.set(node, { node, depth: 0, shown: 0 })
    used += cost
    topShown++
  }
  if (topShown < top.length) folded = true

  // Open categories level by level.
  let frontier = opts.topLevelOnly
    ? []
    : top.slice(0, topShown).filter((n): n is TopicCategory => n.kind === 'category')
  if (opts.topLevelOnly && top.some(n => n.kind === 'category' && n.children.length > 0)) folded = true
  while (frontier.length > 0) {
    const next: TopicCategory[] = []
    for (const cat of frontier) {
      const slot = slots.get(cat)!
      if (cat.children.length === 0) continue
      const childCosts = cat.children.map(c => lineFor(c, slot.depth + 1, 0).length + 1)
      const all = childCosts.reduce((a, b) => a + b, 0)
      // Opening a category drops its count suffix; account for that too.
      const saved = lineFor(cat, slot.depth, 0).length - lineFor(cat, slot.depth, 1).length

      let shown = 0
      if (used + all - saved <= budgetChars) {
        shown = cat.children.length
        used += all - saved
      } else {
        const reserve = moreLine(cat, slot.depth, cat.children.length).length + 1
        let spend = -saved + reserve
        for (const cost of childCosts) {
          if (used + spend + cost > budgetChars) break
          spend += cost
          shown++
        }
        if (shown > 0) used += spend
        folded = true
      }
      slot.shown = shown
      for (const child of cat.children.slice(0, shown)) {
        slots.set(child, { node: child, depth: slot.depth + 1, shown: 0 })
        if (child.kind === 'category') next.push(child)
      }
    }
    frontier = next
  }

  const lines: string[] = []
  const emit = (node: TopicNode): void => {
    const slot = slots.get(node)
    if (!slot) return
    lines.push(lineFor(node, slot.depth, slot.shown))
    if (node.kind === 'category' && slot.shown > 0) {
      for (const child of node.children.slice(0, slot.shown)) emit(child)
      if (slot.shown < node.children.length) {
        lines.push(moreLine(node, slot.depth, node.children.length - slot.shown))
      }
    }
  }
  for (const node of top) emit(node)
  if (topShown < top.length) {
    lines.push(`- … ${top.length - topShown} more at the top level`)
  }

  return { lines, folded, usedChars: lines.reduce((n, l) => n + l.length + 1, 0) }
}

function baseName(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i === -1 ? relPath : relPath.slice(i + 1)
}

export function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`
}
