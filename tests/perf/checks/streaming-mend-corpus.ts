#!/usr/bin/env tsx
/**
 * Is tail-only streaming Markdown preparation still a safe replacement for
 * mending and lexing the whole reply on every delta? Streams every markdown
 * document under a root through `createStreamingMarkdown` and runs the
 * differential in `lib/streaming-mend-differential.ts` at every step.
 *
 *   npx tsx tests/perf/checks/streaming-mend-corpus.ts [root] [stride]
 *
 * The committed repository holds too little markdown to be evidence (the unit
 * test covers it); the corpus that exercises real reply shapes is local and
 * untracked — `local_docs/`, `.halo/`, exported conversations. Point `root` at
 * a checkout that has them. A thin corpus fails rather than passes.
 *
 * Also prints the per-delta cost of both paths on synthetic 20K replies.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import remend from 'remend'
import { parseMarkdownIntoBlocks } from 'streamdown'
import { createStreamingMarkdown } from '../../../src/renderer/lib/streaming-markdown'
import { checkStreamingMarkdown, streamingCuts } from '../lib/streaming-mend-differential'

const MIN_CORPUS = 1000
/** Whole-text mending is quadratic; longer documents make the scan take hours. */
const MAX_DOC_CHARS = 12_000
const SKIP = new Set(['node_modules', '.git', 'dist', 'release', 'out'])

const ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..'))
const STRIDE = Number(process.argv[3] ?? 397)

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

/** Mean per-delta cost of streaming `text` in 40-character deltas, over its last `window` deltas. */
function perDeltaMs(text: string, prepare: (content: string) => unknown, window = 50): number {
  const cuts = streamingCuts(text.length, 40)
  for (const cut of cuts.slice(0, cuts.length - window)) prepare(text.slice(0, cut))
  const start = performance.now()
  for (const cut of cuts.slice(-window)) prepare(text.slice(0, cut))
  return (performance.now() - start) / window
}

const files = collectMarkdown(ROOT)
const counts: Record<string, number> = {}
const failures: string[] = []
let updates = 0
for (const file of files) {
  let content: string
  try { content = fs.readFileSync(file, 'utf8').slice(0, MAX_DOC_CHARS) } catch { continue }
  const parser = createStreamingMarkdown()
  for (const cut of streamingCuts(content.length, STRIDE)) {
    updates++
    const prefix = content.slice(0, cut)
    const check = checkStreamingMarkdown(prefix, parser.update(prefix))
    counts[check.comparison] = (counts[check.comparison] ?? 0) + 1
    if (!check.blocksExact || !check.settledVerbatim || check.comparison === 'unexplained') {
      failures.push(`${path.relative(ROOT, file)}@${cut}: ${check.comparison}, blocksExact=${check.blocksExact}, settledVerbatim=${check.settledVerbatim}`)
    }
  }
}

console.log(JSON.stringify({ root: ROOT, files: files.length, updates, counts, failures: failures.length }, null, 2))

const SHAPES: Record<string, string> = {
  'mixed (paragraphs, lists, code)': 'Here is **some** explanation with `inline code`, a [link](https://x.y) and a list:\n\n- one\n- two\n- three\n\n```ts\nexport function add(a: number, b: number) {\n  return a + b\n}\n```\n',
  'link paragraphs': 'See [the docs](https://example.com/docs/page) and **this** for details.\n\n',
}
for (const [name, unit] of Object.entries(SHAPES)) {
  let text = ''
  while (text.length < 20_000) text += unit
  const before = perDeltaMs(text, content => parseMarkdownIntoBlocks(remend(content)))
  const parser = createStreamingMarkdown()
  const after = perDeltaMs(text, content => parser.update(content))
  console.log(`20K ${name}, per delta at the tail: whole-text ${before.toFixed(2)} ms, tail-only ${after.toFixed(2)} ms`)
}

for (const failure of failures.slice(0, 30)) console.log(`  ${failure}`)

if (files.length < MIN_CORPUS) {
  console.error(`Corpus too thin: ${files.length} documents < ${MIN_CORPUS}. Point the check at a checkout with local markdown.`)
  process.exit(1)
}
process.exit(failures.length === 0 ? 0 : 1)
