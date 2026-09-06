#!/usr/bin/env node
/**
 * Regenerates the tracked fixtures in this directory.
 *
 * The files themselves are committed — this script exists so their shapes are
 * reproducible and auditable rather than opaque blobs. Each one is sized to
 * actually trigger the code path it tests (the chunking threshold in
 * MarkdownViewer, split boundaries in markdown-chunks.ts, column count in
 * CsvViewer).
 *
 * This script does NOT modify anything under src/. The `simulateSplit()`
 * function below is a READ-ONLY copy of the algorithm in
 * src/renderer/lib/markdown-chunks.ts, pasted here only so this script can
 * verify offline where each fixture's split boundaries actually land —
 * it is never imported by the app.
 *
 * Run from the repo root: node tests/perf/fixtures/regression/generate.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

const OUT_DIR = path.resolve(process.cwd(), 'tests/perf/fixtures/regression')
fs.mkdirSync(OUT_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Read-only copy of src/renderer/lib/markdown-chunks.ts, for offline
// verification only. Keep in sync manually if the source ever changes;
// do not import from src (this script must not depend on a TS toolchain).
// ---------------------------------------------------------------------------
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const HEADING_RE = /^ {0,3}#{1,6}\s/
const DEFAULT_MIN_CHARS = 4000
const DEFAULT_MAX_CHARS = 16000

function simulateSplit(content, minChars = DEFAULT_MIN_CHARS, maxChars = DEFAULT_MAX_CHARS) {
  if (!content) return []
  const lines = content.split('\n')
  const chunks = []
  let current = []
  let size = 0
  let openFence = null
  let prevWasBlank = false

  const flush = () => {
    if (current.length === 0) return
    chunks.push(current.join('\n'))
    current = []
    size = 0
  }

  for (const line of lines) {
    const fence = FENCE_RE.exec(line)
    if (openFence) {
      if (fence && fence[1][0] === openFence[0] && fence[1].length >= openFence.length) {
        openFence = null
      }
    } else {
      if (fence) {
        openFence = fence[1]
      } else if (prevWasBlank && size > 0) {
        const atHeading = HEADING_RE.test(line)
        if ((atHeading && size >= minChars) || size >= maxChars) {
          flush()
        }
      }
    }
    current.push(line)
    size += line.length + 1
    prevWasBlank = !openFence && line.trim() === ''
  }
  flush()
  return chunks
}

// ---------------------------------------------------------------------------
// Deterministic ASCII filler (keeps .length === byte count, so targets are
// exact and match `wc -c` with no UTF-8 multi-byte surprises).
// ---------------------------------------------------------------------------
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec',
  'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu']

function makeParagraph(n) {
  const out = []
  let len = 0
  let i = 0
  while (len < n) {
    const w = WORDS[i % WORDS.length]
    out.push(w)
    len += w.length + 1
    i++
  }
  return out.join(' ').slice(0, n)
}

/** Blank-line separated filler paragraphs totalling at least `totalChars`. No headings inside. */
function makeFiller(totalChars, paraLen = 400) {
  const paras = []
  let len = 0
  while (len < totalChars) {
    const p = makeParagraph(paraLen)
    paras.push(p)
    len += p.length + 2
  }
  return paras.join('\n\n')
}

const CHUNK_THRESHOLD = 128000
const PAD_MARGIN = 6000 // generous margin above the 128,000 threshold so we're never borderline by accident

function write(name, content) {
  const p = path.join(OUT_DIR, name)
  fs.writeFileSync(p, content, 'utf8')
  const bytes = fs.statSync(p).size
  console.log(`${name}\t${bytes} bytes\t${content.length} chars`)
  return { name, path: p, bytes, content }
}

const results = []

// ---------------------------------------------------------------------------
// 1. details-container.md — HTML container split across a chunk boundary
//    (counterexample #1). Split must land right before "## Inner
//    Heading", separating <details> from </details>.
// ---------------------------------------------------------------------------
{
  let doc = '<details>\n<summary>Expand</summary>\n\n'
  doc += makeFiller(4500) // > minChars(4000) so the next heading is an eligible flush point
  doc += '\n\n## Inner Heading\n\nsecret body that must stay hidden inside the collapsed <details> block until a user clicks to expand it.\n\n</details>\n\n'
  doc += makeFiller(CHUNK_THRESHOLD + PAD_MARGIN) // padding so total file exceeds the 128,000 MarkdownViewer threshold
  results.push(write('details-container.md', doc))
}

// ---------------------------------------------------------------------------
// 2. html-comment.md — HTML comment split across a chunk boundary
//    (counterexample #2). Split must land right before
//    "# TODO delete this", separating "<!--" from "-->".
// ---------------------------------------------------------------------------
{
  let doc = makeFiller(4500)
  doc += '\n\n<!--\n\n# TODO delete this\n\ndraft text that must never render as visible text.\n\n-->\n\ndone\n\n'
  doc += makeFiller(CHUNK_THRESHOLD + PAD_MARGIN)
  results.push(write('html-comment.md', doc))
}

// ---------------------------------------------------------------------------
// 3. footnotes.md — footnote reference and definition split into different
//    chunks (counterexample #3).
// ---------------------------------------------------------------------------
{
  let doc = 'Ref here[^1].\n\n'
  doc += makeFiller(4500)
  doc += '\n\n## Later\n\ntext\n\n[^1]: the definition\n\n'
  doc += makeFiller(CHUNK_THRESHOLD + PAD_MARGIN)
  results.push(write('footnotes.md', doc))
}

// ---------------------------------------------------------------------------
// 4. nested-list.md — 3-level nested list, each level long enough that
//    repeated maxChars(16,000) boundaries land on 2/3/4-space-indented lines
//    (counterexamples #4 and #5). No headings at all, so every split in
//    this file is forced by the maxChars branch, not the heading branch.
// ---------------------------------------------------------------------------
{
  const LEVEL_LEN = 2000
  let doc = ''
  while (doc.length < CHUNK_THRESHOLD + PAD_MARGIN) {
    const l1 = makeParagraph(LEVEL_LEN)
    const l2 = makeParagraph(LEVEL_LEN)
    const l3 = makeParagraph(LEVEL_LEN)
    doc += `- ${l1}\n\n  - ${l2}\n\n    - ${l3}\n\n`
  }
  results.push(write('nested-list.md', doc))
}

// ---------------------------------------------------------------------------
// 5. indented-code.md — one continuous 4-space-indented code block (non-
//    fenced) containing blank lines throughout, long enough that maxChars
//    boundaries fall mid-block (counterexample #6). Correct rendering
//    is exactly ONE <pre>; a broken splitter produces several.
// ---------------------------------------------------------------------------
{
  let doc = 'Intro:\n\n'
  const LINE_LEN = 700
  while (doc.length < CHUNK_THRESHOLD + PAD_MARGIN) {
    doc += '    ' + makeParagraph(LINE_LEN) + '\n\n'
  }
  results.push(write('indented-code.md', doc))
}

// ---------------------------------------------------------------------------
// 6. threshold-below.md / threshold-above.md — exactly 128,000 and 128,001
//    chars. MarkdownViewer.tsx:96 uses a strict `>`, so the first must take
//    the original single-pass path and the second must chunk. Built from the
//    same filler stream so the only textual difference is the trailing
//    character — any rendering difference beyond that is the thing under test.
// ---------------------------------------------------------------------------
{
  const filler = makeFiller(CHUNK_THRESHOLD + 2000)
  const below = filler.slice(0, CHUNK_THRESHOLD)      // exactly 128,000 chars
  const above = filler.slice(0, CHUNK_THRESHOLD + 1)  // exactly 128,001 chars, below + 1 char
  results.push(write('threshold-below.md', below))
  results.push(write('threshold-above.md', above))
}

// ---------------------------------------------------------------------------
// 7. wide-columns.csv — 2,000 columns x 200 rows. Tests the "many columns,
//    few rows" shape that row-only virtualization does not help with
//    (CsvViewer.tsx:345 still maps over the full columnCount per visible row).
// ---------------------------------------------------------------------------
{
  const COLS = 2000
  const ROWS = 200
  const header = Array.from({ length: COLS }, (_, i) => `col${i + 1}`).join(',')
  const lines = [header]
  for (let r = 1; r <= ROWS; r++) {
    lines.push(Array.from({ length: COLS }, (_, c) => `r${r}c${c + 1}`).join(','))
  }
  const csv = lines.join('\n') + '\n'
  results.push(write('wide-columns.csv', csv))
}

// ---------------------------------------------------------------------------
// Offline verification: run the duplicated split algorithm over each
// markdown fixture and report where the boundaries actually land, so we're
// not just hoping the construction worked.
// ---------------------------------------------------------------------------
console.log('\n--- split verification (simulateSplit, MarkdownViewer defaults 4000/16000) ---')
for (const r of results) {
  if (!r.name.endsWith('.md')) continue
  const chunks = simulateSplit(r.content)
  console.log(`\n${r.name}: content.length=${r.content.length} (${r.content.length > CHUNK_THRESHOLD ? '> 128000, WILL chunk' : '<= 128000, will NOT chunk'}), chunks=${chunks.length}`)
  if (r.name === 'details-container.md') {
    const idx = chunks.findIndex(c => c.includes('## Inner Heading'))
    const detailsOpenChunk = chunks.findIndex(c => c.includes('<details>'))
    console.log(`  <details> opens in chunk ${detailsOpenChunk}, "## Inner Heading" lands in chunk ${idx} -> ${detailsOpenChunk !== idx ? 'SPLIT CONFIRMED (bug reproduces)' : 'NOT split (unexpected)'}`)
  }
  if (r.name === 'html-comment.md') {
    const openIdx = chunks.findIndex(c => c.includes('<!--'))
    const todoIdx = chunks.findIndex(c => c.includes('TODO delete this'))
    console.log(`  "<!--" is in chunk ${openIdx}, "TODO delete this" is in chunk ${todoIdx} -> ${openIdx !== todoIdx ? 'SPLIT CONFIRMED (bug reproduces)' : 'NOT split (unexpected)'}`)
  }
  if (r.name === 'footnotes.md') {
    const refIdx = chunks.findIndex(c => c.includes('Ref here[^1]'))
    const defIdx = chunks.findIndex(c => c.includes('[^1]: the definition'))
    console.log(`  reference is in chunk ${refIdx}, definition is in chunk ${defIdx} -> ${refIdx !== defIdx ? 'SPLIT CONFIRMED (bug reproduces)' : 'NOT split (unexpected)'}`)
  }
  if (r.name === 'nested-list.md') {
    const indentedStarts = chunks.slice(1).map((c, i) => ({ i: i + 1, head: c.slice(0, 24) })).filter(x => /^\s/.test(x.head))
    console.log(`  ${chunks.length} chunks total; chunks starting with leading whitespace (indentation lost at boundary): ${indentedStarts.length ? JSON.stringify(indentedStarts) : 'none'}`)
  }
  if (r.name === 'indented-code.md') {
    console.log(`  ${chunks.length} chunk(s) -> correct rendering needs exactly 1 <pre>; current splitter produces ${chunks.length > 1 ? `${chunks.length} separate <pre> blocks (bug reproduces)` : '1 (no split)'}`)
  }
}

console.log('\nDone. Files written to', OUT_DIR)
