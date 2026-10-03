/**
 * Source-scanning helpers for architecture guard tests.
 *
 * Guards under `tests/unit/architecture/` encode rules that must hold across
 * the whole codebase (e.g. "a delta event never carries the accumulated
 * content"). They read source text rather than importing modules, so a
 * guard stays cheap and never depends on Electron being available.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

export const REPO_ROOT = resolve(__dirname, '../../../..')

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']

/** Every source file under `dir` (repo-relative), skipping declaration files. */
export function listSourceFiles(dir: string): string[] {
  const root = join(REPO_ROOT, dir)
  const out: string[] = []
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const full = join(current, name)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.endsWith('.d.ts')) {
        out.push(relative(REPO_ROOT, full))
      }
    }
  }
  walk(root)
  return out.sort()
}

export function readSource(repoRelativePath: string): string {
  return readFileSync(join(REPO_ROOT, repoRelativePath), 'utf-8')
}

export interface SourceMatch {
  file: string
  line: number
  text: string
}

/** Lines in `files` matching `pattern`, formatted for a readable failure message. */
export function findMatches(files: readonly string[], pattern: RegExp): SourceMatch[] {
  const matches: SourceMatch[] = []
  for (const file of files) {
    const lines = readSource(file).split('\n')
    lines.forEach((text, index) => {
      if (pattern.test(text)) matches.push({ file, line: index + 1, text: text.trim() })
    })
  }
  return matches
}

export function formatMatches(matches: readonly SourceMatch[]): string {
  return matches.map((m) => `${m.file}:${m.line}  ${m.text}`).join('\n')
}
