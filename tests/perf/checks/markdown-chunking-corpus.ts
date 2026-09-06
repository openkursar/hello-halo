#!/usr/bin/env tsx
/**
 * Does `splitMarkdownIntoChunks` still actually split real documents?
 *
 *   npx tsx tests/perf/checks/markdown-chunking-corpus.ts
 *
 * Synthetic fixtures cannot answer this. Real documents carry shapes nobody
 * writes on purpose — self-closing HTML at line start, JSX inside inline code,
 * pasted JS stack traces, regex character classes — and each of those has made
 * a guard misfire and turn virtualization off for the whole document. The worst
 * regression of the optimization round (11 of 42 real documents silently
 * unvirtualized) was invisible to every synthetic test.
 *
 * That power comes entirely from local, untracked content: on this repo the
 * over-threshold documents live in `local_docs/`, `.halo/` and other ignored
 * paths, so a fresh clone finds almost none. Hence MIN_CORPUS below — a thin
 * corpus is reported as a failure, never as a pass, because "scanned nothing,
 * found nothing wrong" is indistinguishable from a real pass in every way that
 * matters to a gate.
 *
 * When this fails, adding a filename to an exemption list is never the fix. The
 * two exemptions below are properties of the *document* (it contains footnote
 * definitions; it contains a lone unclosed fence), machine-checkable and
 * therefore impossible to abuse into "one more line and it goes green".
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { splitMarkdownIntoChunks } from '../../../src/renderer/lib/markdown-chunks'

/** Mirrors CHUNKED_RENDER_THRESHOLD_CHARS in MarkdownViewer. */
const THRESHOLD = 128_000
/** Mirrors DEFAULT_MAX_CHARS in splitMarkdownIntoChunks. */
const MAX_CHARS = 16_000

/**
 * Fewest over-threshold documents that make a verdict meaningful. The
 * regression this check exists to catch hit 11 of 42 documents (26%); at 10
 * documents the chance of a regression that size touching none of them is
 * 0.74^10 ≈ 5%. Below that the scan is not evidence.
 */
const MIN_CORPUS = 10

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
// Build output and third-party code only. `.halo/` stays in: it is an ignored
// local snapshot whose documents are exactly the CJK-plus-pasted-logs shape
// that breaks guards. The documents that grow at runtime live outside the repo
// under `~/.halo/spaces/**`; this scan cannot reach them, and that blind spot
// is still open. Pointing at that absolute path deliberately is not an option —
// it varies per machine, so it could never be a fixed gate.
//
// The threshold compares `content.length` (characters), not file size in
// bytes. The ratio depends on the CJK/latin mix: measured 1.8x-2.58x here.
// Filtering a corpus with `wc -c` turns 44 documents into 73. That error is
// one-directional though — UTF-8 guarantees bytes >= chars, so a byte filter
// is always a superset and can never miss a genuinely over-threshold document.
const SKIP = new Set(['node_modules', '.git', 'dist', 'release', 'out'])

function collectMarkdown(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectMarkdown(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

/**
 * Collapsing to a single chunk is acceptable for exactly two reasons, each
 * detectable from the document itself: it defines footnotes (by design the
 * whole document stays together), or it contains a lone unclosed fence, after
 * which CommonMark treats everything as code text and no safe split point
 * exists. Anything else is a guard misfiring.
 */
function hasFootnoteDefinition(content: string): boolean {
  return /^ {0,3}\[\^[\w-]{1,200}\]:/m.test(content)
}

function hasUnclosedFence(content: string): boolean {
  let open: string | null = null
  for (const line of content.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (!m) continue
    if (!open) open = m[1]
    else if (m[1][0] === open[0] && m[1].length >= open.length) open = null
  }
  return open !== null
}

/**
 * Chunks an ideal splitter with no guards at all would produce, obeying only
 * the three hard constraints (split after a blank line, next line unindented,
 * maxChars already accumulated). It is the upper bound on the real count:
 * actual close to ideal means the guards did no harm, actual far below it is a
 * misfire. Counting split points alone is not enough — they can all sit at the
 * top with none in the middle.
 */
function idealChunkCount(content: string, maxChars: number): number {
  const lines = content.split('\n')
  let chunks = 1
  let size = 0
  let prevBlank = false
  for (const line of lines) {
    if (prevBlank && size >= maxChars && line.trim() !== '' && !/^\s/.test(line)) {
      chunks++
      size = 0
    }
    size += line.length + 1
    prevBlank = line.trim() === ''
  }
  return chunks
}

const failures: string[] = []

const corpus: { len: number; chunks: number; rel: string }[] = []
for (const file of collectMarkdown(ROOT)) {
  let content = ''
  try { content = fs.readFileSync(file, 'utf8') } catch { continue }
  if (content.length <= THRESHOLD) continue
  corpus.push({ len: content.length, chunks: splitMarkdownIntoChunks(content).length, rel: path.relative(ROOT, file) })
}
corpus.sort((a, b) => b.len - a.len)

if (corpus.length < MIN_CORPUS) {
  console.log(`[0] corpus unavailable — found ${corpus.length} document(s) over ${THRESHOLD} chars, need ${MIN_CORPUS}`)
  console.log('    This check reads local, untracked markdown; a fresh clone has almost none.')
  console.log('    Run it on a machine holding real documents, or point the scan at one.')
  console.log()
  console.log('FAIL — corpus too thin for the result to mean anything')
  process.exit(1)
}

const collapsed = corpus.filter(f => f.chunks === 1)
console.log(`[1] ${corpus.length} over-threshold documents, ${collapsed.length} collapsed to a single chunk`)
let unexplained = 0
for (const f of collapsed) {
  const content = fs.readFileSync(path.join(ROOT, f.rel), 'utf8')
  const why = hasFootnoteDefinition(content) ? 'defines footnotes, kept whole by design'
    : hasUnclosedFence(content) ? 'lone unclosed fence, no safe split point exists'
    : null
  console.log(`      ${f.len}ch -> 1  ${why ?? '[UNEXPLAINED — likely a guard misfiring]'}  ${f.rel}`)
  if (!why) unexplained++
}
if (unexplained > 0) failures.push(`${unexplained} collapsed document(s) explained by neither footnotes nor an unclosed fence`)

const starved: typeof corpus = []
const unsplittable: typeof corpus = []
for (const f of corpus) {
  if (f.chunks >= f.len / (4 * MAX_CHARS)) continue
  const full = fs.readFileSync(path.join(ROOT, f.rel), 'utf8')
  // Already accounted for above; counting them twice reports one document as
  // two findings.
  //
  // The cost of this exemption, stated so nobody reads it as total coverage:
  // it skipped 5 of 44 documents (~11%) here — 1 with footnotes, 4 with an
  // unclosed fence. One of those splits into 11 chunks perfectly well and is
  // waved through only because a single fence somewhere in it is unclosed, so
  // a guard misfiring on that document would go unseen. Being able to say
  // where a check is blind is the precondition for trusting it.
  if (hasFootnoteDefinition(full) || hasUnclosedFence(full)) continue
  ;(f.chunks < idealChunkCount(full, MAX_CHARS) / 2 ? starved : unsplittable).push(f)
}
console.log(`[2] below expected yield (chunks < length/${4 * MAX_CHARS}): ${starved.length} misfiring, ${unsplittable.length} genuinely unsplittable`)
for (const f of starved) console.log(`      misfire  ${f.len}ch -> ${f.chunks}  ${f.rel}`)
for (const f of unsplittable) console.log(`      no split points (fine)  ${f.len}ch -> ${f.chunks}  ${f.rel}`)
if (starved.length > 0) failures.push(`${starved.length} document(s) had enough split points but were not split`)

console.log()
if (failures.length === 0) {
  console.log(`PASS — ${corpus.length} documents scanned`)
} else {
  console.log(`FAIL — ${failures.length}:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}
