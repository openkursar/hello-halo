#!/usr/bin/env tsx
/**
 * Correctness guards for `src/renderer/lib/markdown-chunks.ts`, run against
 * committed fixtures only — portable, no local corpus, finishes in seconds.
 *
 *   npx tsx tests/perf/fixtures/ensure.ts        # prerequisite
 *   npx tsx tests/perf/checks/markdown-chunking-guards.ts
 *
 * This half proves the splitter still refuses to cut where cutting changes
 * what the reader sees. The other half — whether it still *does* cut real
 * documents — needs a real corpus and lives in `markdown-chunking-corpus.ts`.
 * Passing this one alone says nothing about that; the round that motivated
 * these checks had every synthetic guard green while 11 of 42 real documents
 * had silently lost virtualization.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { splitMarkdownIntoChunks } from '../../../src/renderer/lib/markdown-chunks'
import { fixturePath } from '../lib/fixture-store'

const regressionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/regression')

/** Chunk count of the 2MB baseline document, quoted in the performance report. */
const BASELINE_CHUNKS = 449

const guards: Array<{ file: string; ok: (chunks: string[]) => boolean; breaks: string }> = [
  { file: 'details-container.md', ok: c => c.findIndex(x => x.includes('<details>\n')) === c.findIndex(x => x.includes('</details>')), breaks: '<details> block split across chunks' },
  { file: 'html-comment.md', ok: c => c.findIndex(x => x.includes('<!--')) === c.findIndex(x => x.includes('-->')), breaks: 'HTML comment split across chunks' },
  { file: 'footnotes.md', ok: c => c.length === 1, breaks: 'document containing footnote definitions was split' },
  { file: 'nested-list.md', ok: c => !c.some(x => /^\s/.test(x)), breaks: 'a chunk starts with whitespace' },
  { file: 'indented-code.md', ok: c => !c.some(x => /^\s/.test(x)), breaks: 'a chunk starts with whitespace' }
]

const failures: string[] = []

for (const { file, ok, breaks } of guards) {
  const full = path.join(regressionRoot, file)
  if (!fs.existsSync(full)) {
    failures.push(`fixture missing: ${file}`)
    continue
  }
  const passed = ok(splitMarkdownIntoChunks(fs.readFileSync(full, 'utf8')))
  console.log(`  ${passed ? 'OK  ' : 'FAIL'}  ${file}${passed ? '' : ` — ${breaks}`}`)
  if (!passed) failures.push(`${file}: ${breaks}`)
}

// Throws if the fixture is absent or its bytes do not match the manifest, so
// this assertion cannot degrade into a skip the way its predecessor did.
const baselineFile = fixturePath('md-extreme-2mb.md')
const chunks = splitMarkdownIntoChunks(fs.readFileSync(baselineFile, 'utf8')).length
const baselineOk = chunks === BASELINE_CHUNKS
console.log(`  ${baselineOk ? 'OK  ' : 'FAIL'}  md-extreme-2mb.md = ${chunks} chunks (report quotes ${BASELINE_CHUNKS})`)
if (!baselineOk) failures.push(`2MB baseline went from ${BASELINE_CHUNKS} to ${chunks} chunks — the report's numbers need rechecking`)

console.log()
if (failures.length === 0) {
  console.log(`PASS — ${guards.length} guards + baseline chunk count`)
} else {
  console.log(`FAIL — ${failures.length}:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}
