/**
 * dsh is an experimental engine carried beside the main line: nothing outside
 * its adapter may depend on it, so it can fail, go missing from a build, or be
 * deleted without touching any other feature. The main line reaches it at
 * three registration points only, and the two that run at startup load it
 * lazily so an unselected dsh costs nothing.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../../../../..')
const SRC = path.join(ROOT, 'src')
const DSH_ADAPTER = path.join(SRC, 'main', 'services', 'agent', 'dsh')
const DSH_BUILD_INPUTS = path.join(ROOT, 'runtimes', 'dsh')

/** File (relative to src/) → how it may import the adapter. */
const ALLOWED: Record<string, { specifier: string; dynamic: boolean }[]> = {
  'main/services/agent/capabilities.ts': [{ specifier: './dsh/capabilities', dynamic: false }],
  'main/services/agent/resolved-sdk.ts': [{ specifier: './dsh', dynamic: true }],
  'main/services/agent/engine-availability.ts': [{ specifier: './dsh/runtime', dynamic: true }],
}

const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return full === DSH_ADAPTER ? [] : sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

function isInside(target: string, dir: string): boolean {
  return target === dir || target.startsWith(dir + path.sep)
}

interface DshImport {
  file: string
  specifier: string
  dynamic: boolean
}

function findDshImports(): DshImport[] {
  const found: DshImport[] = []
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf-8')
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1]
      if (!specifier.startsWith('.')) continue
      const target = path.resolve(path.dirname(file), specifier)
      if (!isInside(target, DSH_ADAPTER) && !isInside(target, DSH_BUILD_INPUTS)) continue
      found.push({
        file: path.relative(SRC, file).split(path.sep).join('/'),
        specifier,
        dynamic: /^import\s*\(/.test(match[0]),
      })
    }
  }
  return found
}

describe('dsh engine boundary', () => {
  const imports = findDshImports()

  it('is reached from the main line only through its registration points', () => {
    const outside = imports.filter(
      imp => !ALLOWED[imp.file]?.some(rule => rule.specifier === imp.specifier)
    )
    expect(outside).toEqual([])
  })

  it('is loaded lazily wherever startup reaches it', () => {
    const eager = imports.filter(
      imp => ALLOWED[imp.file]?.some(rule => rule.specifier === imp.specifier && rule.dynamic && !imp.dynamic)
    )
    expect(eager).toEqual([])
  })

  it('still finds every registration point, so the scan itself is not stale', () => {
    const seen = new Set(imports.map(imp => `${imp.file}:${imp.specifier}`))
    const expected = Object.entries(ALLOWED).flatMap(([file, rules]) => rules.map(r => `${file}:${r.specifier}`))
    expect(expected.filter(key => !seen.has(key))).toEqual([])
  })
})
