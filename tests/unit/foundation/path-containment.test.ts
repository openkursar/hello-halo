/**
 * foundation/path-containment: a path argument is judged where the engine that
 * runs the tool will actually go.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  canonicalPath,
  globSearchRoot,
  isPathWithin,
  resolveToolPath,
} from '../../../src/main/foundation/path-containment'

const cwd = resolve('/work/space')

describe('resolveToolPath', () => {
  it('expands `~` and `~/` to the home folder, as the Claude engine does', () => {
    expect(resolveToolPath('~', cwd)).toBe(homedir())
    expect(resolveToolPath('~/', cwd)).toBe(homedir())
    expect(resolveToolPath('~/.ssh/id_rsa', cwd)).toBe(join(homedir(), '.ssh/id_rsa'))
    expect(resolveToolPath('  ~  ', cwd)).toBe(homedir())
  })

  it('leaves environment variables and `~user` literal', () => {
    expect(resolveToolPath('$HOME', cwd)).toBe(join(cwd, '$HOME'))
    expect(resolveToolPath('~root', cwd)).toBe(join(cwd, '~root'))
  })

  it('resolves relative paths and `..` against the working directory', () => {
    expect(resolveToolPath('', cwd)).toBe(cwd)
    expect(resolveToolPath('src/a.ts', cwd)).toBe(join(cwd, 'src/a.ts'))
    expect(resolveToolPath('../..', cwd)).toBe(resolve(cwd, '../..'))
    expect(resolveToolPath('/etc/../etc/passwd', cwd)).toBe(resolve('/etc/passwd'))
  })
})

describe('globSearchRoot', () => {
  it('is the fixed folder before the first wildcard of any kind', () => {
    expect(globSearchRoot('**/*.ts', cwd)).toBe(cwd)
    expect(globSearchRoot('src/**/{a,b}.ts', cwd)).toBe(join(cwd, 'src'))
    expect(globSearchRoot('../**', cwd)).toBe(resolve(cwd, '..'))
    expect(globSearchRoot('/etc/{passwd,hosts}', cwd)).toBe(resolve('/etc'))
    expect(globSearchRoot('~/**', cwd)).toBe(homedir())
    expect(globSearchRoot(`${cwd}*/**`, cwd)).toBe(resolve(cwd, '..'))
  })
})

describe('containment', () => {
  it('follows links, including through a folder not created yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'containment-'))
    try {
      mkdirSync(join(root, 'inside'))
      symlinkSync(tmpdir(), join(root, 'inside', 'out'))
      expect(isPathWithin(join(root, 'inside', 'a.md'), root)).toBe(true)
      expect(isPathWithin(join(root, 'inside', 'out', 'not-yet', 'x'), join(root, 'inside'))).toBe(false)
      expect(canonicalPath(join(root, 'inside', 'new', 'x'))).toBe(join(canonicalPath(join(root, 'inside')), 'new', 'x'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not take a sibling sharing a prefix for the folder', () => {
    expect(isPathWithin('/work/space-other/a', '/work/space')).toBe(false)
    expect(isPathWithin('/work/space/a', '/work/space')).toBe(true)
  })
})
