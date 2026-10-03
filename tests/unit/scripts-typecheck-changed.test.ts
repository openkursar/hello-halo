/**
 * typecheck-changed must see every changed file, including each file inside a
 * brand-new directory — git only lists those individually with
 * `--untracked-files=all`, and the script asks for it.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// @ts-expect-error plain .mjs helper without declarations
import { parsePorcelain } from '../../scripts/typecheck-changed-lib.mjs'

describe('parsePorcelain', () => {
  it('reads modified, added, untracked and renamed entries', () => {
    const out = [' M src/a.ts', 'A  src/b.ts', '?? src/c.ts', 'R  old.ts -> src/d.ts', '?? "src/with space.ts"', ''].join('\n')
    expect(parsePorcelain(out)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/with space.ts'])
  })
})

describe('the script', () => {
  it('asks git for untracked files one by one', () => {
    const script = readFileSync(join(__dirname, '../../scripts/typecheck-changed.mjs'), 'utf-8')
    expect(script).toMatch(/'status', '--porcelain', '--untracked-files=all'/)
  })

  it('lists files inside a new directory only with --untracked-files=all', () => {
    const repo = mkdtempSync(join(tmpdir(), 'halo-tc-'))
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' })
      git('init', '-q')
      mkdirSync(join(repo, 'tests', 'unit', 'fresh'), { recursive: true })
      writeFileSync(join(repo, 'tests', 'unit', 'fresh', 'a.test.ts'), 'export {}')
      writeFileSync(join(repo, 'tests', 'unit', 'fresh', 'b.test.ts'), 'export {}')

      expect(parsePorcelain(git('status', '--porcelain'))).toEqual(['tests/'])
      expect(parsePorcelain(git('status', '--porcelain', '--untracked-files=all')).sort()).toEqual([
        'tests/unit/fresh/a.test.ts',
        'tests/unit/fresh/b.test.ts',
      ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
