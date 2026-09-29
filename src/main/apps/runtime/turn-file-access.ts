/**
 * Where a strict turn's file tools may reach — an IM guest's, or a teammate's
 * from another machine. (A teammate from this machine is the owner's own and
 * is held to the tool switches only, as it always was.)
 *
 * A capability policy only names tools; granting Read would otherwise grant the
 * whole computer. So every file tool call of such a turn is judged by path, in
 * the same terms whichever layer asks (the pre-tool hook, the per-call gate,
 * the file-send gate):
 *
 *   memory      the digital human's own memory (memory.md + topics) is readable
 *               and writable, the space's topics readable when offered —
 *               whether or not the policy grants file tools at all
 *   attached    files handed to this turn (what the guest sent) are readable
 *   workspace   a GRANTED tool reaches the workspace folder, never beyond it
 *   closed      the space's `.halo/` data folder — every conversation's record
 *               lives there — stays closed except for the memory above
 *
 * Paths are read the way the engines read them when they run the tool
 * (foundation/path-containment `resolveToolPath`: `~` expanded, no environment
 * variables), so what is judged is what runs.
 *
 * A granted search from the workspace root still recurses. Both engines are
 * kept out of `.halo/` there by read-deny rules ({@link closedFolderDenyRules}),
 * which each engine applies while it walks, so a closed file never enters a
 * result window. A search also runs at the physical path that was judged, and
 * whatever a rule could not name is removed from its output after the fact
 * ({@link filterSearchOutput}).
 */

import { existsSync, readdirSync } from 'fs'
import { isAbsolute, join, normalize, resolve, sep } from 'path'
import {
  canonicalPath,
  globSearchRoot,
  isCanonicalWithin,
  physicalPath,
  resolveToolPath,
} from '../../foundation/path-containment'

export interface TurnFileAccess {
  /** The session's working directory; relative paths resolve against it */
  cwd: string
  /** Memory content this turn may write — also readable */
  memoryWritable: string[]
  /** Memory content this turn may only read */
  memoryReadable: string[]
  /** Exact files handed to this turn */
  attachedFiles: string[]
  /** Where a granted file tool may reach */
  workspaceRoots: string[]
  /** Folders inside the workspace that stay closed except for memory */
  closed: string[]
  /**
   * Closed folders the Claude engine's deny rules leave out, because a file of
   * this turn may live there (persisted images). The hook still refuses every
   * other file in them.
   */
  hookGuarded: string[]
  /** System records inside the memory folders, closed even to recursion */
  memorySystemPaths: string[]
}

export const READ_FILE_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep']
export const WRITE_FILE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
export const FILE_TOOLS: readonly string[] = [...READ_FILE_TOOLS, ...WRITE_FILE_TOOLS]

export type FileAccessDecision = { allow: true } | { allow: false; reason: string }

/** Canonical forms of an access's roots, computed once per access. */
interface Canonical {
  writable: string[]
  readable: string[]
  attached: Set<string>
  workspace: string[]
  closed: string[]
}

const canonicalCache = new WeakMap<TurnFileAccess, Canonical>()

function canonicalOf(access: TurnFileAccess): Canonical {
  let c = canonicalCache.get(access)
  if (!c) {
    c = {
      writable: access.memoryWritable.map(canonicalPath),
      readable: [...access.memoryWritable, ...access.memoryReadable].map(canonicalPath),
      attached: new Set(access.attachedFiles.map(canonicalPath)),
      workspace: access.workspaceRoots.map(canonicalPath),
      closed: access.closed.map(canonicalPath),
    }
    canonicalCache.set(access, c)
  }
  return c
}

const withinAny = (target: string, roots: string[]) => roots.some(root => isCanonicalWithin(target, root))

/**
 * The paths a file tool call reaches: its path arguments, the folder a Glob
 * pattern reaches, and — for a search with no path — the working directory.
 */
export function fileToolTargets(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
  const targets: string[] = []
  for (const key of ['file_path', 'notebook_path']) {
    const raw = input[key]
    if (typeof raw === 'string' && raw.length > 0) targets.push(resolveToolPath(raw, cwd))
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    const raw = input.path
    const base = typeof raw === 'string' && raw.length > 0 ? resolveToolPath(raw, cwd) : resolve(cwd)
    if (toolName === 'Glob' && typeof input.pattern === 'string') {
      // A relative pattern like `.halo/apps/**` reaches below its search root.
      targets.push(globSearchRoot(input.pattern, base))
    } else {
      targets.push(base)
    }
  }
  return targets
}

/**
 * Judge one file tool call. null when the tool is not a file tool — the policy
 * decides as usual.
 *
 * @param granted - Whether the policy grants this tool by name
 */
export function decideFileAccess(
  access: TurnFileAccess,
  toolName: string,
  input: Record<string, unknown>,
  granted: boolean
): FileAccessDecision | null {
  const reading = READ_FILE_TOOLS.includes(toolName)
  if (!reading && !WRITE_FILE_TOOLS.includes(toolName)) return null

  const targets = fileToolTargets(toolName, input, access.cwd)
  if (targets.length === 0) return { allow: false, reason: `"${toolName}" needs a path.` }

  const c = canonicalOf(access)
  const memory = reading ? c.readable : c.writable

  for (const raw of targets) {
    const target = canonicalPath(raw)
    if (withinAny(target, memory) || (reading && c.attached.has(target))) continue
    if (!granted) {
      return {
        allow: false,
        reason: `"${toolName}" is available here only for your memory files. Give a path inside your memory.`,
      }
    }
    if (!withinAny(target, c.workspace)) {
      return { allow: false, reason: 'Only files inside this workspace can be used here.' }
    }
    if (withinAny(target, c.closed)) {
      return {
        allow: false,
        reason: "The workspace's internal data folder is closed here, except for memory.",
      }
    }
  }
  return { allow: true }
}

/**
 * Why a file may not leave this turn (sent to a chat or a channel), or null
 * when it may. Only the closed folders matter here — the file-send gate
 * already holds its own roots — and memory stays sendable.
 */
export function fileExportRefusal(access: TurnFileAccess, realPath: string): string | null {
  const c = canonicalOf(access)
  const target = canonicalPath(realPath)
  if (!withinAny(target, c.closed)) return null
  if (withinAny(target, c.readable) || c.attached.has(target)) return null
  return "Files in the workspace's internal data folder cannot be sent from here."
}

/**
 * A search tool's `path` as the engine should run it: the very path the
 * boundary judged, links resolved. An engine runs a `path` as written and
 * prints every result under that spelling — `<ws>/./.halo/…`, or a link such
 * as `/Volumes/Macintosh HD/…` that reaches the workspace another way — which
 * no test against the workspace's own spelling would recognise. null when
 * nothing changes.
 */
export function searchPathRewrite(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): Record<string, unknown> | null {
  if (toolName !== 'Grep' && toolName !== 'Glob') return null
  const raw = input.path
  if (typeof raw !== 'string' || raw.length === 0) return null
  const physical = physicalPath(resolveToolPath(raw, cwd))
  return physical === raw ? null : { ...input, path: physical }
}

/** The Halo engine's Grep and Glob windows, and the notes it prints under them. */
const GREP_DEFAULT_HEAD_LIMIT = 250
const GLOB_MAX_RESULTS = 250
const GREP_PAGE_NOTE = /^\[Showing lines \d+-\d+ of (?:at least )?\d+ matching lines\./
const GLOB_MORE_NOTE = /^\.\.\. and \d+ more files \(showing first \d+ of \d+,/
const TRUNCATION_NOTE = /^\.\.\. \[output truncated at \d+ chars\./
const NO_MATCH = /^No (?:matches found for pattern|files matched pattern) /

/**
 * A Grep or Glob result without the lines that name a closed path — the
 * backstop behind the engines' own read-deny rules, which keep a search from
 * ever opening a closed file (both engines honour {@link closedFolderDenyRules}).
 *
 * Removed lines go without a word, and a result left empty reads exactly as
 * the engine's own "no matches". The engine's paging note counts every line it
 * collected, so it is always replaced by one that depends only on what the
 * caller already knows. The window itself was filled before any removal, so a
 * search this filter had to clean can still differ from one that never met the
 * file; that is why it is only the backstop.
 *
 * Each line is judged by the path it starts with, in every spelling that can
 * name the same file: as printed, with the search `path` as written replaced
 * by its resolved form, with the search root's links resolved, and lexically
 * normalised.
 *
 * @returns null when the result stands as it is
 */
export function filterSearchOutput(
  access: TurnFileAccess,
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  cwd: string = access.cwd
): string | null {
  if (toolName !== 'Grep' && toolName !== 'Glob') return null
  if (NO_MATCH.test(output)) return null
  const win = process.platform === 'win32'
  const fold = (p: string) => {
    const q = win ? p.replace(/\//g, '\\') : p
    return win || process.platform === 'darwin' ? q.toLowerCase() : q
  }
  // Both the path as written and as the filesystem resolves it: an engine prints
  // the former, and `/tmp` vs `/private/tmp` style links make them differ.
  const forms = (paths: string[]) => [...new Set(paths.flatMap(p => [fold(resolve(p)), canonicalPath(p)]))]
  const closed = forms(access.closed)
  const open = forms([...access.memoryWritable, ...access.memoryReadable, ...access.attachedFiles])
  const under = (line: string, root: string) => line === root || line.startsWith(root + sep)

  const rawPath = typeof input.path === 'string' && input.path.length > 0 ? input.path : null
  const searchRoot = rawPath ? resolveToolPath(rawPath, cwd) : resolve(cwd)
  const foldedRoot = fold(searchRoot)
  const physicalRoot = canonicalPath(searchRoot)
  // [printed, written, physical, normalised] — prefix substitutions first.
  const spellings = (line: string): string[] => {
    const printed = fold(line)
    let written = printed
    if (rawPath && line.startsWith(rawPath)) {
      const rest = line.slice(rawPath.length)
      written = fold(rest === '' || /^[\\/]/.test(rest) ? searchRoot + rest : searchRoot + sep + rest)
    }
    let physical = written
    if (written === foldedRoot || written.startsWith(foldedRoot + sep)) {
      physical = physicalRoot + written.slice(foldedRoot.length)
    }
    return [printed, written, physical, fold(normalize(written))]
  }
  const isClosed = (line: string) => {
    const names = spellings(line)
    if (!names.some(n => closed.some(root => under(n, root)))) return false
    // Open content stays, recognised only by the path the line starts with —
    // never by the normalised form, where `..` in the matched text could climb.
    return !names.slice(0, 3).some(n =>
      open.some(root => under(n, root) || n.startsWith(root + ':') || n.startsWith(root + '-'))
    )
  }

  // What the engine showed, apart from its notes.
  let truncation: string | null = null
  const shown: string[] = []
  for (const line of output.split('\n')) {
    if (GREP_PAGE_NOTE.test(line) || GLOB_MORE_NOTE.test(line)) continue
    if (TRUNCATION_NOTE.test(line)) {
      truncation = line
      continue
    }
    shown.push(line)
  }
  while (shown.length && shown[shown.length - 1] === '') shown.pop()

  // Context separators left around dropped lines would still mark where they were.
  const lines: string[] = []
  let pendingSeparator = false
  let visible = 0
  for (const line of shown) {
    if (line === '--') {
      pendingSeparator = lines.length > 0
      continue
    }
    if (line.trim() && isClosed(line.trim())) continue
    if (pendingSeparator && line.trim()) lines.push('--')
    if (line.trim()) {
      pendingSeparator = false
      visible++
    }
    if (line.trim() || lines.length) lines.push(line)
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return noMatches(toolName, input, cwd)

  let result = lines.join('\n')
  if (toolName === 'Grep') {
    const limit = typeof input.head_limit === 'number' ? input.head_limit : GREP_DEFAULT_HEAD_LIMIT
    const offset = typeof input.offset === 'number' ? input.offset : 0
    if (truncation || (limit > 0 && shown.length >= limit)) {
      // A full window's size is the caller's own head_limit; a window cut by
      // size is not, so there the count is of what is shown — re-showing a
      // few lines is harmless, a count of hidden ones is not.
      const next = offset + (truncation ? visible : shown.length)
      result += `\n\n[More matching lines may follow. Use offset=${next} to continue, ` +
        'or narrow the search with a more specific pattern, glob, type, or path.]'
    }
    if (truncation) result += `\n${truncation}`
  } else {
    result += '\n'
    if (shown.length >= GLOB_MAX_RESULTS) {
      result += `\n... and possibly more files (showing the first ${GLOB_MAX_RESULTS}, sorted by most recent ` +
        'modification). Narrow the pattern or search a subdirectory to see the rest.\n'
    }
  }
  return result === output ? null : result
}

/** The engine's own words for a search that found nothing (Halo engine). */
function noMatches(toolName: string, input: Record<string, unknown>, cwd: string): string {
  const pattern = String(input.pattern ?? '')
  const raw = typeof input.path === 'string' && input.path ? input.path : null
  const root = raw ? (isAbsolute(raw) ? raw : resolve(cwd, raw)) : cwd
  return toolName === 'Grep'
    ? `No matches found for pattern "${pattern}" in ${root}. Check the pattern syntax (ripgrep regex), broaden the pattern, or search a different path.`
    : `No files matched pattern "${pattern}" in ${root}`
}

/**
 * Read-deny rules, in the Claude engine's permission syntax, for everything
 * closed that is not on the way to open memory. Both engines leave denied
 * paths out of Grep and Glob while walking, so a search from the workspace
 * root does not recurse into conversation records.
 *
 * Folders are listed as they stand when the rules are built — every strict
 * turn builds them again, and a changed list rebuilds the session. The memory
 * system's own records are named whether or not they exist yet. Hook-guarded
 * folders are left out on purpose (see {@link TurnFileAccess.hookGuarded}).
 */
export function closedFolderDenyRules(access: TurnFileAccess): string[] {
  const open = [...access.memoryWritable, ...access.memoryReadable].map(canonicalPath)
  const guarded = access.hookGuarded.map(canonicalPath)
  const rules = new Set<string>()

  const deny = (path: string, isDir: boolean) => rules.add(`Read(${ccAbsolute(path)}${isDir ? '/**' : ''})`)
  const leadsToOpen = (path: string) => { const c = canonicalPath(path); return open.some(o => isCanonicalWithin(o, c)) }
  const skip = (path: string) => { const c = canonicalPath(path); return withinAny(c, open) || withinAny(c, guarded) }

  const walk = (dir: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (skip(path)) continue
      if (entry.isDirectory() && leadsToOpen(path) && depth < 8) walk(path, depth + 1)
      else if (!leadsToOpen(path)) deny(path, entry.isDirectory())
    }
  }

  for (const root of access.closed) {
    if (!existsSync(root)) continue
    if (leadsToOpen(root) || access.hookGuarded.some(g => canonicalPath(g).startsWith(canonicalPath(root)))) walk(root, 0)
    else deny(root, true)
  }
  for (const path of access.memorySystemPaths) {
    if (access.closed.some(root => isCanonicalWithin(canonicalPath(path), canonicalPath(root)))) {
      deny(path, !path.endsWith('.json'))
    }
  }
  return [...rules].sort()
}

/** An absolute path as that engine's rule syntax spells one: a leading `//`. */
function ccAbsolute(path: string): string {
  const abs = resolve(path)
  if (process.platform === 'win32') {
    const drive = abs.match(/^([A-Za-z]):[\\/](.*)$/)
    if (drive) return `//${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
  }
  return `/${abs}`
}
