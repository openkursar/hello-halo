/**
 * Parsers for git's machine-readable (`-z`) output. Pure functions.
 *
 * With `-z` git prints paths raw — spaces, quotes, non-ASCII and newlines
 * included — and ends every record with NUL. A path is therefore always the
 * last field of its record (or a record of its own), never split on spaces.
 */

import type { GitFileState } from '../../../shared/types/git'

/**
 * NUL-terminated records. The piece after the last NUL is dropped: it is empty
 * for complete output and a partial record for output cut at a size limit.
 */
export function splitNul(text: string): string[] {
  const parts = text.split('\0')
  parts.pop()
  return parts
}

/** The first `count` space-separated fields of a record, then the remainder (the path). */
function splitFields(record: string, count: number): { fields: string[]; rest: string } | null {
  const fields: string[] = []
  let start = 0
  for (let i = 0; i < count; i++) {
    const end = record.indexOf(' ', start)
    if (end < 0) return null
    fields.push(record.slice(start, end))
    start = end + 1
  }
  return { fields, rest: record.slice(start) }
}

/** A diff status letter (`git diff --raw`, porcelain XY) as a file state; null for "unchanged". */
export function stateFromLetter(letter: string): GitFileState | null {
  switch (letter) {
    case '.':
    case ' ':
    case '':
      return null
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'type-changed'
    case 'U':
      return 'conflicted'
    default:
      return 'modified'
  }
}

// ── git status --porcelain=v2 --branch -z ────────────────────────────────────

export interface BranchHeader {
  /** Full HEAD commit; null before the first commit. */
  oid: string | null
  /** Branch name; null when HEAD is detached. */
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
}

export type StatusEntry =
  | { kind: 'changed'; xy: string; path: string; origPath?: string }
  | { kind: 'unmerged'; xy: string; path: string }
  | { kind: 'untracked'; path: string }

export interface PorcelainStatus {
  branch: BranchHeader
  entries: StatusEntry[]
}

export function parsePorcelainV2(text: string): PorcelainStatus {
  const branch: BranchHeader = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 }
  const entries: StatusEntry[] = []
  const records = splitNul(text)

  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    switch (record[0]) {
      case '#': {
        const [key, ...values] = record.slice(2).split(' ')
        const value = values.join(' ')
        if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value
        else if (key === 'branch.head') branch.head = value === '(detached)' ? null : value
        else if (key === 'branch.upstream') branch.upstream = value
        else if (key === 'branch.ab') {
          const match = /^\+(\d+) -(\d+)$/.exec(value)
          if (match) {
            branch.ahead = Number(match[1])
            branch.behind = Number(match[2])
          }
        }
        break
      }
      case '1': {
        // 1 XY sub mH mI mW hH hI path
        const parsed = splitFields(record, 8)
        if (parsed) entries.push({ kind: 'changed', xy: parsed.fields[1], path: parsed.rest })
        break
      }
      case '2': {
        // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
        const parsed = splitFields(record, 9)
        const origPath = records[i + 1]
        i++
        if (parsed && origPath !== undefined) entries.push({ kind: 'changed', xy: parsed.fields[1], path: parsed.rest, origPath })
        break
      }
      case 'u': {
        // u XY sub m1 m2 m3 mW h1 h2 h3 path
        const parsed = splitFields(record, 10)
        if (parsed) entries.push({ kind: 'unmerged', xy: parsed.fields[1], path: parsed.rest })
        break
      }
      case '?':
        entries.push({ kind: 'untracked', path: record.slice(2) })
        break
      default:
        // '!' (ignored) is not requested; anything else is a format this parser predates.
        break
    }
  }
  return { branch, entries }
}

// ── git diff --raw --numstat -z ──────────────────────────────────────────────

export interface RawEntry {
  /** Status letter: A C D M R T U X. */
  status: string
  path: string
  oldPath?: string
}

export interface NumstatEntry {
  /** Null for a binary file. */
  additions: number | null
  deletions: number | null
  path: string
  oldPath?: string
}

/**
 * `--raw` and `--numstat` output in one stream: all raw records first, then all
 * numstat records. Either section may be absent. Renames and copies spread
 * over extra records (old path, then new path) in both formats.
 */
export function parseRawAndNumstat(text: string): { raw: RawEntry[]; numstat: NumstatEntry[] } {
  const raw: RawEntry[] = []
  const numstat: NumstatEntry[] = []
  const tokens = splitNul(text)

  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i++]
    if (token.startsWith(':')) {
      // :oldMode newMode oldOid newOid STATUS[score]
      const letter = token.slice(token.lastIndexOf(' ') + 1)[0] ?? 'M'
      if (letter === 'R' || letter === 'C') {
        const oldPath = tokens[i++]
        const path = tokens[i++]
        if (path === undefined) break
        raw.push({ status: letter, path, oldPath })
      } else {
        const path = tokens[i++]
        if (path === undefined) break
        raw.push({ status: letter, path })
      }
      continue
    }

    // additions TAB deletions TAB path   — or, for a rename, an empty path then old and new
    const first = token.indexOf('\t')
    const second = first < 0 ? -1 : token.indexOf('\t', first + 1)
    if (second < 0) continue
    const added = token.slice(0, first)
    const deleted = token.slice(first + 1, second)
    const binary = added === '-' || deleted === '-'
    const counts = {
      additions: binary ? null : Number(added),
      deletions: binary ? null : Number(deleted),
    }
    const path = token.slice(second + 1)
    if (path !== '') {
      numstat.push({ ...counts, path })
      continue
    }
    const oldPath = tokens[i++]
    const newPath = tokens[i++]
    if (newPath === undefined) break
    numstat.push({ ...counts, path: newPath, oldPath })
  }
  return { raw, numstat }
}

// ── git ls-tree -l -z / git ls-files -s -z ──────────────────────────────────

export interface TreeEntry {
  mode: string
  type: string
  oid: string
  /** Null for trees and submodule commits. */
  size: number | null
  path: string
}

/** `<mode> <type> <oid> <size>\t<path>` per record. */
export function parseLsTree(text: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const record of splitNul(text)) {
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode, type, oid, size] = record.slice(0, tab).trim().split(/\s+/)
    entries.push({ mode, type, oid, size: size && size !== '-' ? Number(size) : null, path: record.slice(tab + 1) })
  }
  return entries
}

export interface IndexEntry {
  mode: string
  oid: string
  stage: number
  path: string
}

/** `<mode> <oid> <stage>\t<path>` per record. */
export function parseLsFilesStage(text: string): IndexEntry[] {
  const entries: IndexEntry[] = []
  for (const record of splitNul(text)) {
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode, oid, stage] = record.slice(0, tab).split(' ')
    entries.push({ mode, oid, stage: Number(stage), path: record.slice(tab + 1) })
  }
  return entries
}

// ── git check-attr -z ───────────────────────────────────────────────────────

/** `<path> NUL <attribute> NUL <value> NUL` triplets → path → value. */
export function parseCheckAttr(text: string): Map<string, string> {
  const values = new Map<string, string>()
  const tokens = splitNul(text)
  for (let i = 0; i + 2 < tokens.length; i += 3) values.set(tokens[i], tokens[i + 2])
  return values
}

/** An attribute value that turns the attribute on (`attr`, `attr=true`). */
export function isAttributeSet(value: string | undefined): boolean {
  return value === 'set' || value === 'true'
}

// ── for-each-ref ─────────────────────────────────────────────────────────────

/** Lines of `%00`-separated fields (ref names cannot contain newlines or NUL). */
export function parseRefLines(text: string): string[][] {
  return text.split('\n').filter((line) => line.length > 0).map((line) => line.split('\0'))
}

/** `%(upstream:track,nobracket)`: "ahead 2, behind 1", "behind 3", "gone" or "". */
export function parseTrack(track: string): { ahead: number; behind: number } {
  return {
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
  }
}
