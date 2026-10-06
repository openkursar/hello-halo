/**
 * Canvas links for inline-code paths and named Markdown files in AI replies.
 *
 * Links exist only inside a `FileLinkProvider` — the main chat's replies and
 * the review report — so every other Markdown surface pays nothing. A mention
 * becomes a link only when the main process confirms it names a file of the
 * space; mentions on screen at the same moment are asked about in one request,
 * and answers are cached per space. Becoming a link changes only colour and
 * underline (see globals.css), so the text never shifts.
 */

import { createContext, useContext, useEffect, useMemo, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { api } from '../../api'
import i18n from '../../i18n'
import { canvasLifecycle } from '../../services/canvas-lifecycle'
import { displayPath } from '../../../shared/content-reference'
import type { ReferenceLineRange } from '../../../shared/types/content-reference'
import { detectFileLink, detectFileMention, type FileMention } from './file-mentions'

export interface FileLinkTarget {
  /** Absolute path of the file. */
  path: string
  range?: ReferenceLineRange
}

export interface FileLinkOptions {
  spaceId: string
  /** Directory relative mentions resolve against (inside the space); default: the space's working directory. */
  baseDir?: string
  /** Handles a click; return true when handled, false to open the file in the canvas. */
  onOpen?: (target: FileLinkTarget) => boolean
}

const FileLinkContext = createContext<FileLinkOptions | null>(null)

export function FileLinkProvider({ spaceId, baseDir, onOpen, children }: FileLinkOptions & { children: ReactNode }) {
  const value = useMemo(() => ({ spaceId, baseDir, onOpen }), [spaceId, baseDir, onOpen])
  return <FileLinkContext.Provider value={value}>{children}</FileLinkContext.Provider>
}

export function useFileLinkOptions(): FileLinkOptions | null {
  return useContext(FileLinkContext)
}

// ============================================
// Existence, asked once and remembered
// ============================================

/** Answers kept; the oldest are forgotten first. */
const CACHE_LIMIT = 2000
/** A file the AI mentions may be written a moment later, so "not there" is re-asked after this. */
const MISSING_TTL_MS = 60_000
/** Paths one request may carry (the main process answers at most this many). */
const REQUEST_LIMIT = 200

interface CachedAnswer {
  absolutePath: string | null
  at: number
}

const answers = new Map<string, CachedAnswer>()

function cacheKey(spaceId: string, baseDir: string | undefined, path: string): string {
  return `${spaceId}\0${baseDir ?? ''}\0${path}`
}

/** The cached answer: a path, null for "no such file", undefined when unknown or stale. */
function peek(key: string): string | null | undefined {
  const answer = answers.get(key)
  if (!answer) return undefined
  if (answer.absolutePath === null && Date.now() - answer.at > MISSING_TTL_MS) {
    answers.delete(key)
    return undefined
  }
  // Refresh recency.
  answers.delete(key)
  answers.set(key, answer)
  return answer.absolutePath
}

function remember(key: string, absolutePath: string | null): void {
  answers.delete(key)
  answers.set(key, { absolutePath, at: Date.now() })
  while (answers.size > CACHE_LIMIT) answers.delete(answers.keys().next().value as string)
}

interface PendingBatch {
  spaceId: string
  baseDir: string | undefined
  waiters: Map<string, Array<(absolutePath: string | null) => void>>
}

const batches = new Map<string, PendingBatch>()

async function flush(batch: PendingBatch): Promise<void> {
  const paths = [...batch.waiters.keys()]
  for (let i = 0; i < paths.length; i += REQUEST_LIMIT) {
    const chunk = paths.slice(i, i + REQUEST_LIMIT)
    let resolved = new Map<string, string | null>()
    try {
      const response = await api.resolveArtifactPaths(batch.spaceId, chunk, batch.baseDir)
      if (response.success && response.data) {
        resolved = new Map(response.data.map(entry => [entry.path, entry.absolutePath && !entry.isDirectory ? entry.absolutePath : null]))
      } else {
        console.warn('[FileLinks] Path check failed', { error: response.error })
      }
    } catch (error) {
      console.warn('[FileLinks] Path check failed', error)
    }
    for (const path of chunk) {
      const absolutePath = resolved.get(path) ?? null
      // A failed request is not remembered: the next render asks again.
      if (resolved.size > 0) remember(cacheKey(batch.spaceId, batch.baseDir, path), absolutePath)
      for (const waiter of batch.waiters.get(path) ?? []) waiter(absolutePath)
    }
  }
}

/** Absolute path of the file `path` names, asked together with every other mention of this moment. */
function resolveMention(spaceId: string, baseDir: string | undefined, path: string): Promise<string | null> {
  const batchKey = `${spaceId}\0${baseDir ?? ''}`
  let batch = batches.get(batchKey)
  if (!batch) {
    const created: PendingBatch = { spaceId, baseDir, waiters: new Map() }
    batches.set(batchKey, created)
    setTimeout(() => {
      batches.delete(batchKey)
      void flush(created)
    }, 0)
    batch = created
  }
  const waiters = batch.waiters.get(path) ?? []
  batch.waiters.set(path, waiters)
  return new Promise(resolve => waiters.push(resolve))
}

// ============================================
// Turning marked mentions into links
// ============================================

function linkLabel(path: string, range: ReferenceLineRange | undefined): string {
  if (!range) return i18n.t('Open {{path}}', { path })
  return range.startLine === range.endLine
    ? i18n.t('Open {{path}} at line {{line}}', { path, line: range.startLine })
    : i18n.t('Open {{path}} at lines {{start}}–{{end}}', { path, start: range.startLine, end: range.endLine })
}

function makeLink(code: HTMLElement, absolutePath: string, mention: FileMention, baseDir: string | undefined): void {
  code.dataset.fileLink = absolutePath
  if (mention.range) code.dataset.fileLines = `${mention.range.startLine}-${mention.range.endLine}`
  code.setAttribute('role', 'link')
  code.tabIndex = 0
  const shown = displayPath(absolutePath, baseDir)
  code.title = mention.range ? `${shown}:${mention.range.startLine}${mention.range.endLine !== mention.range.startLine ? `-${mention.range.endLine}` : ''}` : shown
  code.setAttribute('aria-label', linkLabel(shown, mention.range))
}

/**
 * After each render of `content`, turns the marked mentions under `rootRef`
 * that name existing files into links. Cached answers apply at once.
 */
export function useFileMentionLinks(rootRef: RefObject<HTMLElement | null>, content: string, options: FileLinkOptions | null): void {
  useEffect(() => {
    const root = rootRef.current
    if (!root || !options) return
    for (const linked of root.querySelectorAll<HTMLElement>('[data-file-link]')) {
      delete linked.dataset.fileLink
      delete linked.dataset.fileLines
      linked.removeAttribute('role')
      linked.removeAttribute('tabindex')
      linked.removeAttribute('aria-label')
      linked.title = linked.dataset.fileMention ?? ''
    }
    const codes = root.querySelectorAll<HTMLElement>('code[data-file-mention], span[data-file-mention]')
    if (codes.length === 0) return
    let cancelled = false
    for (const code of codes) {
      const raw = code.dataset.fileMention ?? ''
      const mention = code.tagName === 'SPAN' ? detectFileLink(raw) : detectFileMention(raw)
      if (!mention) continue
      const known = peek(cacheKey(options.spaceId, options.baseDir, mention.path))
      if (known) {
        makeLink(code, known, mention, options.baseDir)
        continue
      }
      if (known === null) continue
      void resolveMention(options.spaceId, options.baseDir, mention.path).then(absolutePath => {
        if (!cancelled && absolutePath && code.isConnected) makeLink(code, absolutePath, mention, options.baseDir)
      })
    }
    return () => {
      cancelled = true
    }
  }, [rootRef, content, options])
}

function targetOf(code: HTMLElement): FileLinkTarget | null {
  const path = code.dataset.fileLink
  if (!path) return null
  const lines = code.dataset.fileLines?.split('-').map(Number)
  return lines && lines.length === 2 && lines.every(Number.isFinite)
    ? { path, range: { startLine: lines[0], endLine: lines[1] } }
    : { path }
}

function openTarget(target: FileLinkTarget, options: FileLinkOptions): void {
  if (options.onOpen?.(target)) return
  void canvasLifecycle.openFile(target.path, target.range ? { reveal: { range: target.range } } : undefined)
}

/** Click and Enter handlers for the element that holds the rendered Markdown. */
export function fileLinkHandlers(options: FileLinkOptions | null): {
  onClick?: (event: MouseEvent<HTMLElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
} {
  if (!options) return {}
  const activate = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const code = (event.target as Element).closest?.('code[data-file-link], span[data-file-link]') as HTMLElement | null
    const target = code && targetOf(code)
    if (!target) return false
    event.preventDefault()
    openTarget(target, options)
    return true
  }
  return {
    onClick: (event) => {
      activate(event)
    },
    onKeyDown: (event) => {
      if (event.key === 'Enter') activate(event)
    },
  }
}
