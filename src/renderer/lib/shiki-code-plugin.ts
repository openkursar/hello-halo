/**
 * Shiki code highlighter for Streamdown with a bounded token cache.
 *
 * Stands in for `@streamdown/code`, whose module-level token cache keeps every
 * string it ever highlighted. Chat only highlights finished code blocks (a
 * streaming reply renders code without this plugin), so the cache holds
 * completed blocks and is an LRU bounded both by entry count and by total
 * source length — Shiki tokens retain roughly 60 bytes of heap per source
 * character, so the source budget keeps the cache near 5 MB.
 *
 * Tokenizing never runs on the UI thread: one commit can mount dozens of
 * blocks (a large Markdown preview, a finished reply), and a single block can
 * cost 100 ms or more. `highlight` answers from the cache or returns null, and
 * `shiki.worker.ts` tokenizes; results arrive through Streamdown's callback.
 * Without `Worker` (unit tests), or after the worker fails, tokenizing runs
 * in-process in yielding chunks (`shiki-tokenizer.ts`). Blocks over
 * `HIGHLIGHT_MAX_CHARS` stay plain.
 *
 * Loaded through a dynamic import (`streamdown-plugins.ts`); the worker, Shiki
 * and each grammar load on first use.
 */

import { bundledLanguages, bundledLanguagesInfo } from 'shiki/langs'
import type { BundledLanguage, BundledTheme, TokensResult } from 'shiki'
import type { CodeHighlighterPlugin } from 'streamdown'
import type { ShikiTokenizer, Themes, TokenizeRequest } from './shiki-tokenizer'
import type { ShikiWorkerRequest, ShikiWorkerResponse } from './shiki.worker'

export const TOKEN_CACHE_MAX_ENTRIES = 300
export const TOKEN_CACHE_MAX_CHARS = 80_000
export const HIGHLIGHT_MAX_CHARS = 50_000

/** LRU keyed by string, bounded by entry count and by the summed weight of its entries. */
export class BoundedTokenCache<V> {
  private readonly entries = new Map<string, { value: V; weight: number }>()
  private totalWeight = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
  ) {}

  get size(): number {
    return this.entries.size
  }

  get weight(): number {
    return this.totalWeight
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  /** An entry heavier than the whole budget is not stored. */
  set(key: string, value: V, weight: number): void {
    const existing = this.entries.get(key)
    if (existing) {
      this.entries.delete(key)
      this.totalWeight -= existing.weight
    }
    if (weight > this.maxWeight) return
    this.entries.set(key, { value, weight })
    this.totalWeight += weight
    for (const [oldestKey, oldest] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalWeight <= this.maxWeight) break
      this.entries.delete(oldestKey)
      this.totalWeight -= oldest.weight
    }
  }

  clear(): void {
    this.entries.clear()
    this.totalWeight = 0
  }
}

const LANGUAGE_ALIASES = new Map<string, string>(
  bundledLanguagesInfo.flatMap(info => (info.aliases ?? []).map(alias => [alias, info.id] as [string, string])),
)

function resolveLanguage(language: string): string {
  const normalized = language.trim().toLowerCase()
  return LANGUAGE_ALIASES.get(normalized) ?? normalized
}

function isBundledLanguage(language: string): language is BundledLanguage {
  return Object.prototype.hasOwnProperty.call(bundledLanguages, language)
}

async function inProcessTokenizer(): Promise<ShikiTokenizer> {
  const { createShikiTokenizer } = await import('./shiki-tokenizer')
  return createShikiTokenizer(isBundledLanguage)
}

/**
 * Tokenizer backed by `shiki.worker.ts`. If the worker cannot start or dies,
 * requests in flight and later ones go to the in-process tokenizer.
 */
function workerTokenizer(): ShikiTokenizer {
  let worker: Worker | null = null
  let fallback: Promise<ShikiTokenizer> | null = null
  let nextId = 0
  const pending = new Map<number, { request: TokenizeRequest; resolve: (r: TokensResult) => void; reject: (e: Error) => void }>()

  const inProcess = (request: TokenizeRequest) => (fallback ??= inProcessTokenizer()).then(t => t.tokenize(request))

  const fail = (reason: string) => {
    console.error(`[CodeHighlight] Highlight worker failed (${reason}); highlighting in-process`)
    worker?.terminate()
    worker = null
    const stranded = [...pending.values()]
    pending.clear()
    for (const job of stranded) inProcess(job.request).then(job.resolve, job.reject)
  }

  const start = (): Worker | null => {
    try {
      const created = new Worker(new URL('./shiki.worker.ts', import.meta.url), { type: 'module' })
      created.onmessage = (event: MessageEvent<ShikiWorkerResponse>) => {
        const job = pending.get(event.data.id)
        if (!job) return
        pending.delete(event.data.id)
        if ('result' in event.data) job.resolve(event.data.result)
        else job.reject(new Error(event.data.error))
      }
      created.onerror = (event) => fail(event.message || 'worker error')
      return created
    } catch (error) {
      console.error('[CodeHighlight] Could not start the highlight worker; highlighting in-process:', error)
      return null
    }
  }

  return {
    tokenize(request) {
      if (fallback === null && worker === null) worker = start()
      if (!worker) return inProcess(request)
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { request, resolve, reject })
        worker!.postMessage({ id, request } satisfies ShikiWorkerRequest)
      })
    },
  }
}

type HighlightCallback = (result: TokensResult) => void

export interface ShikiCodePluginOptions {
  themes: [BundledTheme, BundledTheme]
  maxEntries?: number
  maxChars?: number
  /** Defaults to the worker (or in-process where `Worker` does not exist). */
  tokenizer?: ShikiTokenizer
}

export interface ShikiCodePlugin extends CodeHighlighterPlugin {
  /** Exposed for tests and diagnostics. */
  readonly cache: BoundedTokenCache<TokensResult>
}

export function createShikiCodePlugin(options: ShikiCodePluginOptions): ShikiCodePlugin {
  const cache = new BoundedTokenCache<TokensResult>(
    options.maxEntries ?? TOKEN_CACHE_MAX_ENTRIES,
    options.maxChars ?? TOKEN_CACHE_MAX_CHARS,
  )
  const waiting = new Map<string, Set<HighlightCallback>>()
  let tokenizer: ShikiTokenizer | null = options.tokenizer ?? null
  const tokenizerFor = (): ShikiTokenizer => {
    if (!tokenizer) {
      if (typeof Worker === 'undefined') {
        const loading = inProcessTokenizer()
        tokenizer = { tokenize: request => loading.then(t => t.tokenize(request)) }
      } else {
        tokenizer = workerTokenizer()
      }
    }
    return tokenizer
  }

  return {
    name: 'shiki',
    type: 'code-highlighter',
    cache,

    supportsLanguage(language) {
      return isBundledLanguage(resolveLanguage(language))
    },

    getSupportedLanguages() {
      return Object.keys(bundledLanguages) as BundledLanguage[]
    },

    getThemes() {
      return options.themes
    },

    highlight({ code, language, themes }, callback) {
      const lang = resolveLanguage(language)
      const key = `${lang}\u0000${themes[0]}\u0000${themes[1]}\u0000${code}`
      const cached = cache.get(key)
      if (cached) return cached

      if (!callback || code.length > HIGHLIGHT_MAX_CHARS) return null

      let callbacks = waiting.get(key)
      if (!callbacks) {
        callbacks = new Set()
        waiting.set(key, callbacks)
        tokenizerFor().tokenize({ code, lang, themes: themes as Themes }).then(
          (result) => {
            cache.set(key, result, code.length)
            const pending = waiting.get(key)
            waiting.delete(key)
            pending?.forEach(cb => cb(result))
          },
          (error) => {
            waiting.delete(key)
            console.warn('[CodeHighlight] Highlighting failed; showing plain code:', lang, error)
          },
        )
      }
      callbacks.add(callback)
      return null
    },
  }
}
