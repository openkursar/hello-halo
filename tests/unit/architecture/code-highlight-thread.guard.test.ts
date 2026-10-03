/**
 * Shiki tokenizing is 100 ms-class synchronous work per block (and its first
 * use compiles whole grammars), so the UI thread never runs it: renderer code
 * reaches Shiki only through `lib/shiki-code-plugin.ts`, which hands blocks to
 * `lib/shiki.worker.ts`. The in-process tokenizer is the plugin's fallback.
 */

import { describe, expect, it } from 'vitest'
import { findMatches, formatMatches, listSourceFiles } from './lib/source-scan'

const ALLOWED = new Set([
  'src/renderer/lib/shiki-tokenizer.ts',
  'src/renderer/lib/shiki.worker.ts',
])

describe('code highlight thread guard', () => {
  it('no renderer module creates a Shiki highlighter or tokenizes outside the worker path', () => {
    const files = listSourceFiles('src/renderer').filter(file => !ALLOWED.has(file))
    const matches = findMatches(files, /\b(createHighlighter|getSingletonHighlighter|codeToTokens|codeToHtml|codeToHast)\b|from ['"]shiki['"](?!.*import type)/)
      .filter(m => !/^import type /.test(m.text))
    expect(formatMatches(matches)).toBe('')
  })
})
