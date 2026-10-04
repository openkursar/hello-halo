/**
 * git's -z output formats: paths are raw (spaces, CJK, colons) and always the
 * last field, renames spread over two records, and a record cut at an output
 * limit is dropped rather than misread.
 */

import { describe, it, expect } from 'vitest'
import {
  isAttributeSet,
  parseCheckAttr,
  parseLsFilesStage,
  parseLsTree,
  parsePorcelainV2,
  parseRawAndNumstat,
  parseTrack,
  splitNul,
  stateFromLetter,
} from '../../../../src/main/services/git/parse'

const z = (...records: string[]): string => records.map((record) => `${record}\0`).join('')
const OID_A = 'de980441c3ab03a8c07dda1ad27b8a11f39deb1e'
const OID_B = '587be6b4c3f93f93c489c0111bba5596147a26cb'

describe('splitNul', () => {
  it('drops the empty tail of complete output and the partial record of cut output', () => {
    expect(splitNul('a\0b\0')).toEqual(['a', 'b'])
    expect(splitNul('a\0b\0par')).toEqual(['a', 'b'])
    expect(splitNul('')).toEqual([])
  })
})

describe('parsePorcelainV2', () => {
  it('reads the branch header', () => {
    const { branch } = parsePorcelainV2(z(`# branch.oid ${OID_A}`, '# branch.head feature/x', '# branch.upstream origin/feature/x', '# branch.ab +3 -1'))
    expect(branch).toEqual({ oid: OID_A, head: 'feature/x', upstream: 'origin/feature/x', ahead: 3, behind: 1 })
  })

  it('reports an unborn branch and a detached HEAD as null', () => {
    expect(parsePorcelainV2(z('# branch.oid (initial)', '# branch.head main')).branch).toMatchObject({ oid: null, head: 'main' })
    expect(parsePorcelainV2(z(`# branch.oid ${OID_A}`, '# branch.head (detached)')).branch).toMatchObject({ oid: OID_A, head: null })
  })

  it('keeps spaces and CJK in paths, and reads renames with their original path', () => {
    const { entries } = parsePorcelainV2(
      z(
        `1 .M N... 100644 100644 100644 ${OID_A} ${OID_A} dir with space/文件 名.ts`,
        `2 RM N... 100644 100644 100644 ${OID_A} ${OID_A} R100 new name.txt`,
        'old name.txt',
        `1 A. N... 000000 100644 100644 ${'0'.repeat(40)} ${OID_B} bin.dat`,
      ),
    )
    expect(entries).toEqual([
      { kind: 'changed', xy: '.M', path: 'dir with space/文件 名.ts' },
      { kind: 'changed', xy: 'RM', path: 'new name.txt', origPath: 'old name.txt' },
      { kind: 'changed', xy: 'A.', path: 'bin.dat' },
    ])
  })

  it('reads conflicts and untracked files', () => {
    const { entries } = parsePorcelainV2(
      z(`u UU N... 100644 100644 100644 100644 ${OID_A} ${OID_A} ${OID_B} c d.txt`, '? untracked file.txt', '? nested-repo/'),
    )
    expect(entries).toEqual([
      { kind: 'unmerged', xy: 'UU', path: 'c d.txt' },
      { kind: 'untracked', path: 'untracked file.txt' },
      { kind: 'untracked', path: 'nested-repo/' },
    ])
  })

  it('drops a rename whose original path was cut off by the output limit', () => {
    const cut = `${z(`1 .M N... 100644 100644 100644 ${OID_A} ${OID_A} a.txt`)}2 R. N... 100644 100644 100644 ${OID_A} ${OID_A} R100 b.txt\0ol`
    expect(parsePorcelainV2(cut).entries).toEqual([{ kind: 'changed', xy: '.M', path: 'a.txt' }])
  })
})

describe('parseRawAndNumstat', () => {
  it('reads raw records then numstat records, renames included', () => {
    const output = z(
      `:100644 100644 de98044 d68dd40 R075`,
      'a.txt',
      'b.txt',
      ':000000 100644 0000000 8352675 A',
      'bin.dat',
      ':100644 100644 587be6b 0000000 M',
      ':colon.txt',
      '1\t0\t',
      'a.txt',
      'b.txt',
      '-\t-\tbin.dat',
      '2\t5\t:colon.txt',
    )
    expect(parseRawAndNumstat(output)).toEqual({
      raw: [
        { status: 'R', path: 'b.txt', oldPath: 'a.txt' },
        { status: 'A', path: 'bin.dat' },
        { status: 'M', path: ':colon.txt' },
      ],
      numstat: [
        { additions: 1, deletions: 0, path: 'b.txt', oldPath: 'a.txt' },
        { additions: null, deletions: null, path: 'bin.dat' },
        { additions: 2, deletions: 5, path: ':colon.txt' },
      ],
    })
  })

  it('reads numstat-only output', () => {
    expect(parseRawAndNumstat(z('3\t1\tsrc/a b.ts')).numstat).toEqual([{ additions: 3, deletions: 1, path: 'src/a b.ts' }])
  })
})

describe('other formats', () => {
  it('parses ls-tree -l, including trees and submodule commits without a size', () => {
    expect(
      parseLsTree(z(`100644 blob ${OID_A}       5\ta*b.txt`, `040000 tree ${OID_B}       -\tdir`, `160000 commit ${OID_B}       -\tsub`)),
    ).toEqual([
      { mode: '100644', type: 'blob', oid: OID_A, size: 5, path: 'a*b.txt' },
      { mode: '040000', type: 'tree', oid: OID_B, size: null, path: 'dir' },
      { mode: '160000', type: 'commit', oid: OID_B, size: null, path: 'sub' },
    ])
  })

  it('parses ls-files -s stages', () => {
    expect(parseLsFilesStage(z(`100644 ${OID_A} 1\tc.txt`, `100644 ${OID_B} 0\tx y.txt`))).toEqual([
      { mode: '100644', oid: OID_A, stage: 1, path: 'c.txt' },
      { mode: '100644', oid: OID_B, stage: 0, path: 'x y.txt' },
    ])
  })

  it('reads linguist-generated values', () => {
    const values = parseCheckAttr(z('gen.js', 'linguist-generated', 'set', 'a.min.js', 'linguist-generated', 'true', 'x.js', 'linguist-generated', 'unset', 'y.js', 'linguist-generated', 'unspecified'))
    expect(['gen.js', 'a.min.js', 'x.js', 'y.js'].map((path) => isAttributeSet(values.get(path)))).toEqual([true, true, false, false])
  })

  it('reads upstream tracking counts', () => {
    expect(parseTrack('ahead 2, behind 1')).toEqual({ ahead: 2, behind: 1 })
    expect(parseTrack('behind 4')).toEqual({ ahead: 0, behind: 4 })
    expect(parseTrack('gone')).toEqual({ ahead: 0, behind: 0 })
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0 })
  })

  it('maps status letters', () => {
    expect(['.', 'M', 'A', 'D', 'R', 'C', 'T', 'U'].map(stateFromLetter)).toEqual([
      null, 'modified', 'added', 'deleted', 'renamed', 'copied', 'type-changed', 'conflicted',
    ])
  })
})
