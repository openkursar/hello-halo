/**
 * The file panel filter: globs with `**` / `*` / `?`, a slash-less glob that
 * matches file names at any depth, and plain text as a case-insensitive
 * substring of the path. Generated-file rules use the same matching, plus the
 * `.gitattributes` flag git reports.
 */

import { describe, it, expect } from 'vitest'
import { globToRegExp, matchesFilter, matchesGlob } from '../../../../../src/renderer/components/canvas/viewers/changes/model/file-filter'
import { isGeneratedFile } from '../../../../../src/renderer/components/canvas/viewers/changes/model/generated-files'

describe('matchesFilter', () => {
  it('passes everything for an empty query', () => {
    expect(matchesFilter('src/a.ts', '')).toBe(true)
    expect(matchesFilter('src/a.ts', '   ')).toBe(true)
  })

  it('treats plain text as a case-insensitive substring of the path', () => {
    expect(matchesFilter('src/main/Agent.ts', 'agent')).toBe(true)
    expect(matchesFilter('src/main/Agent.ts', 'main/ag')).toBe(true)
    expect(matchesFilter('src/main/Agent.ts', 'renderer')).toBe(false)
  })

  it('matches `dir/**` against everything below the directory only', () => {
    expect(matchesFilter('src/a/b/c.ts', 'src/**')).toBe(true)
    expect(matchesFilter('src/c.ts', 'src/**')).toBe(true)
    expect(matchesFilter('lib/src/c.ts', 'src/**')).toBe(false)
  })

  it('keeps `*` and `?` inside one path segment', () => {
    expect(matchesFilter('src/a.ts', 'src/*.ts')).toBe(true)
    expect(matchesFilter('src/a/b.ts', 'src/*.ts')).toBe(false)
    expect(matchesFilter('src/ab.ts', 'src/a?.ts')).toBe(true)
    expect(matchesFilter('src/a/.ts', 'src/a?.ts')).toBe(false)
  })

  it('matches a slash-less glob against the file name at any depth', () => {
    expect(matchesFilter('docs/guide/intro.md', '*.md')).toBe(true)
    expect(matchesFilter('README.md', '*.md')).toBe(true)
    expect(matchesFilter('docs/guide/intro.mdx', '*.md')).toBe(false)
  })

  it('lets `**/` match no directory at all', () => {
    expect(matchesGlob('src/x.ts', 'src/**/x.ts')).toBe(true)
    expect(matchesGlob('src/a/b/x.ts', 'src/**/x.ts')).toBe(true)
    expect(matchesGlob('tests/unit/a.test.ts', '**/*.test.ts')).toBe(true)
  })

  it('reads a trailing slash as "everything in this directory"', () => {
    expect(matchesGlob('src/renderer/i18n/locales/de.json', 'src/renderer/i18n/locales/')).toBe(true)
    expect(matchesGlob('src/renderer/i18n/index.ts', 'src/renderer/i18n/locales/')).toBe(false)
  })

  it('escapes regular-expression characters in globs', () => {
    expect(globToRegExp('a+b(*).ts').test('a+b(x).ts')).toBe(true)
    expect(globToRegExp('a+b(*).ts').test('aab(x).ts')).toBe(false)
  })
})

describe('isGeneratedFile', () => {
  it('honours the .gitattributes flag git reports', () => {
    expect(isGeneratedFile({ path: 'src/api/schema.ts', generated: true })).toBe(true)
    expect(isGeneratedFile({ path: 'src/api/schema.ts' })).toBe(false)
  })

  it('knows lockfiles in any directory and any case', () => {
    for (const path of ['package-lock.json', 'web/yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'ios/Podfile.lock']) {
      expect(isGeneratedFile({ path }), path).toBe(true)
    }
    expect(isGeneratedFile({ path: 'docs/lock.md' })).toBe(false)
  })

  it('knows minified output, source maps and snapshots', () => {
    for (const path of ['dist/app.min.js', 'public/site.min.css', 'out/main.js.map', 'tests/__snapshots__/view.test.ts.snap', 'a/__snapshots__/x.json']) {
      expect(isGeneratedFile({ path }), path).toBe(true)
    }
    expect(isGeneratedFile({ path: 'src/minify.ts' })).toBe(false)
  })
})
