/**
 * Shiki tokenizing for finished code blocks. Runs inside `shiki.worker.ts`;
 * the in-process form is only a fallback (no `Worker`, or the worker failed).
 *
 * Tokenizing is synchronous TextMate work: a warm 150-line TSX block is
 * ~100 ms in one call, and Oniguruma compiles a rule set's scanner (~100 ms
 * for TSX's root) the first time a line reaches it. A block is tokenized in
 * chunks of lines that continue each other's grammar state, yielding between
 * chunks when a slice is spent; output equals one whole-block call.
 */

import { createHighlighter } from 'shiki'
import type { BundledLanguage, BundledTheme, Highlighter, TokensResult } from 'shiki'

/** Tokenizing work per event-loop turn before yielding. */
const SLICE_MS = 8
const CHUNK_MAX_LINES = 20
const CHUNK_MAX_CHARS = 2_000

export type Themes = [string, string]

export interface TokenizeRequest {
  code: string
  /** Resolved Shiki language id, or an unknown one (tokenized as plain text). */
  lang: string
  themes: Themes
}

export interface ShikiTokenizer {
  tokenize(request: TokenizeRequest): Promise<TokensResult>
}

/** `code` split into chunks of whole lines, each without its trailing newline. */
export function lineChunks(code: string): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let chars = 0
  for (const line of code.split('\n')) {
    if (current.length > 0 && (current.length >= CHUNK_MAX_LINES || chars + line.length > CHUNK_MAX_CHARS)) {
      chunks.push(current.join('\n'))
      current = []
      chars = 0
    }
    current.push(line)
    chars += line.length + 1
  }
  chunks.push(current.join('\n'))
  return chunks
}

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** One highlighter per theme pair; grammars are added to it as blocks ask for them. */
interface ThemedHighlighter {
  ready: Promise<Highlighter>
  languageLoads: Map<string, Promise<void>>
}

export function createShikiTokenizer(isBundledLanguage: (lang: string) => boolean): ShikiTokenizer {
  const highlighters = new Map<string, ThemedHighlighter>()
  let sliceStart = performance.now()

  const highlighterFor = (themes: Themes): ThemedHighlighter => {
    const key = `${themes[0]}\u0000${themes[1]}`
    let entry = highlighters.get(key)
    if (!entry) {
      const created: ThemedHighlighter = {
        ready: createHighlighter({ themes: themes as BundledTheme[], langs: [] }),
        languageLoads: new Map(),
      }
      created.ready.catch(() => highlighters.delete(key))
      highlighters.set(key, created)
      entry = created
    }
    return entry
  }

  const ensureLanguage = (entry: ThemedHighlighter, highlighter: Highlighter, lang: string): Promise<void> => {
    if (!isBundledLanguage(lang) || highlighter.getLoadedLanguages().includes(lang)) return Promise.resolve()
    let load = entry.languageLoads.get(lang)
    if (!load) {
      load = highlighter.loadLanguage(lang as BundledLanguage)
      load.catch(() => entry.languageLoads.delete(lang))
      entry.languageLoads.set(lang, load)
    }
    return load
  }

  const tokenizeOne = async ({ code, lang, themes }: TokenizeRequest): Promise<TokensResult> => {
    const entry = highlighterFor(themes)
    const highlighter = await entry.ready
    await ensureLanguage(entry, highlighter, lang)
    const language = highlighter.getLoadedLanguages().includes(lang) ? (lang as BundledLanguage) : 'text'
    let merged: TokensResult | undefined
    for (const chunk of lineChunks(code)) {
      if (performance.now() - sliceStart > SLICE_MS) {
        await yieldToEventLoop()
        sliceStart = performance.now()
      }
      const part: TokensResult = highlighter.codeToTokens(chunk, {
        lang: language,
        themes: { light: themes[0], dark: themes[1] },
        grammarState: merged?.grammarState,
      })
      if (merged) {
        merged.tokens = merged.tokens.concat(part.tokens)
        merged.grammarState = part.grammarState
      } else {
        merged = part
      }
    }
    // The grammar state is an engine object: not cloneable, and not needed by the renderer.
    const { grammarState: _grammarState, ...result } = merged as TokensResult
    return result
  }

  // One block at a time, so a burst of blocks cannot interleave into one turn.
  let queue: Promise<unknown> = Promise.resolve()
  return {
    tokenize(request) {
      const run = queue.then(() => tokenizeOne(request))
      queue = run.catch(() => undefined)
      return run
    },
  }
}
