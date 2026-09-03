/**
 * Official AI guides — agent-facing documentation delivery.
 *
 * The guides are raw markdown published as static files by the documentation
 * site (`halo-website/docs-src/public/ai-guides/`), so a correction reaches
 * users the moment the docs deploy — no client release, no reinstall. Halo
 * ships a copy of the same tree in `resources/ai-guides/` as the offline floor.
 *
 * Reads therefore resolve in three tiers: live host, then the in-process cache
 * of a previous successful read, then the bundled snapshot. The bundled tier is
 * what lets callers treat a read as infallible — notably the
 * `create_automation_app` precondition, which would deadlock if reading the
 * guide could fail on an air-gapped machine.
 *
 * The document path is a caller-supplied *relative* path, never a URL: the host
 * comes from product.json and the path is validated against traversal, so no
 * caller (and no model driving one) can point this at an arbitrary endpoint.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve, sep } from 'path'
import { app } from 'electron'
import { proxyFetch } from './proxy-fetch'
import { getOfficialContentBaseUrl } from '../foundation/product-config'

const LOG_TAG = '[OfficialDocs]'

/** Short on purpose: an unreachable intranet host must not stall a turn. */
const FETCH_TIMEOUT_MS = 3000
/** Mirrors the packaging cap enforced by scripts/sync-ai-guides.mjs. */
const MAX_DOC_BYTES = 512 * 1024
/** A conversation re-reading the same document should not re-hit the network. */
const CACHE_TTL_MS = 10 * 60 * 1000

export interface OfficialDocSuccess {
  ok: true
  text: string
  /** Which tier answered — surfaced to the model so it knows how fresh this is. */
  source: 'remote' | 'cache' | 'bundled'
  /** Snapshot date, present only for the bundled tier. */
  snapshotDate?: string
}

export interface OfficialDocFailure {
  ok: false
  reason: string
  /** Documents the bundled snapshot does contain, so the caller can recover. */
  available: string[]
}

export type OfficialDocResult = OfficialDocSuccess | OfficialDocFailure

interface CacheEntry {
  text: string
  at: number
}

const cache = new Map<string, CacheEntry>()

// ============================================
// Path validation
// ============================================

/**
 * Accept only a relative markdown path inside the guide tree. Anything that
 * could redirect the read elsewhere — scheme, absolute path, parent segment —
 * is rejected rather than sanitized, so a malformed path fails loudly instead
 * of silently reading a different document.
 */
function validateDocPath(input: string): string | null {
  const path = input.trim()
  if (!path || path.length > 200) return null
  if (!path.endsWith('.md')) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(path)) return null
  if (path.includes('//')) return null
  if (path.split('/').some((segment) => segment === '..' || segment === '')) return null
  return path
}

// ============================================
// Bundled snapshot
// ============================================

let bundledRoot: string | null | undefined
let snapshotDate: string | undefined

/**
 * In dev `app.getAppPath()` is the project root; in a packaged build it points
 * inside app.asar, where `resources/**` lands via the electron-builder `files`
 * list. `process.resourcesPath` covers a variant that ships the tree as an
 * extra resource instead. Mirrors builtin-loader.ts's resolution.
 */
function getBundledRoot(): string | null {
  if (bundledRoot !== undefined) return bundledRoot

  const candidates = [
    join(app.getAppPath(), 'resources', 'ai-guides'),
    join(process.resourcesPath ?? '', 'ai-guides'),
  ]
  bundledRoot = candidates.find((dir) => dir && existsSync(dir)) ?? null

  if (!bundledRoot) {
    console.warn(`${LOG_TAG} No bundled snapshot found; offline reads will fail`)
  } else {
    try {
      const meta = JSON.parse(readFileSync(join(bundledRoot, 'SNAPSHOT.json'), 'utf-8')) as { syncedAt?: string }
      snapshotDate = meta.syncedAt
    } catch {
      // A snapshot without metadata is still usable; only provenance detail is lost.
    }
  }
  return bundledRoot
}

function readBundled(path: string): string | null {
  const root = getBundledRoot()
  if (!root) return null

  const file = resolve(root, path)
  // Defence in depth: validateDocPath already rejects traversal, but the read
  // must never escape the snapshot even if that check is ever loosened.
  if (file !== root && !file.startsWith(root + sep)) return null
  if (!existsSync(file) || !statSync(file).isFile()) return null

  try {
    return readFileSync(file, 'utf-8')
  } catch (error) {
    console.error(`${LOG_TAG} Bundled read failed for ${path}:`, error)
    return null
  }
}

function listBundledDocs(): string[] {
  const root = getBundledRoot()
  if (!root) return []

  const docs: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && entry.name.endsWith('.md')) docs.push(relative(root, abs).split(sep).join('/'))
    }
  }

  try {
    walk(root)
  } catch (error) {
    console.error(`${LOG_TAG} Failed to list bundled docs:`, error)
  }
  return docs.sort()
}

// ============================================
// Remote fetch
// ============================================

async function fetchRemote(path: string): Promise<string | null> {
  const url = `${getOfficialContentBaseUrl()}/${path}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await proxyFetch(url, {
      headers: { Accept: 'text/markdown, text/plain, */*' },
      signal: controller.signal,
    })

    if (!response.ok) {
      console.warn(`${LOG_TAG} ${url} -> ${response.status} ${response.statusText}`)
      return null
    }

    const declaredSize = Number(response.headers.get('content-length') ?? 0)
    if (declaredSize > MAX_DOC_BYTES) {
      console.warn(`${LOG_TAG} ${url} too large (${declaredSize} bytes)`)
      return null
    }

    const text = await response.text()
    if (text.length > MAX_DOC_BYTES) {
      console.warn(`${LOG_TAG} ${url} body too large (${text.length} bytes)`)
      return null
    }

    // A docs host that serves an SPA shell for unknown paths would otherwise
    // hand the model an HTML page as if it were the guide.
    if (/^\s*<(?:!doctype|html)\b/i.test(text)) {
      console.warn(`${LOG_TAG} ${url} returned HTML, not markdown`)
      return null
    }

    console.log(`${LOG_TAG} Fetched ${path} (${text.length} bytes)`)
    return text
  } catch (error) {
    if (controller.signal.aborted) {
      console.warn(`${LOG_TAG} ${url} timed out after ${FETCH_TIMEOUT_MS}ms`)
    } else {
      console.warn(`${LOG_TAG} ${url} failed:`, error)
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================
// Public API
// ============================================

/**
 * Read an official guide document by its path relative to the guide root
 * (e.g. `create-digital-human/SKILL.md`).
 *
 * Resolution: fresh cache -> live host -> stale cache -> bundled snapshot.
 * A stale cache outranks the snapshot because it was published later.
 */
export async function readOfficialDoc(docPath: string): Promise<OfficialDocResult> {
  const path = validateDocPath(docPath)
  if (!path) {
    return {
      ok: false,
      reason:
        `Invalid document path: "${docPath}". Use a relative path inside the guide root, ` +
        `such as "create-digital-human/SKILL.md" (no URLs, no parent segments, must end in .md).`,
      available: listBundledDocs(),
    }
  }

  const cached = cache.get(path)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ok: true, text: cached.text, source: 'cache' }
  }

  const remote = await fetchRemote(path)
  if (remote !== null) {
    cache.set(path, { text: remote, at: Date.now() })
    return { ok: true, text: remote, source: 'remote' }
  }

  if (cached) {
    return { ok: true, text: cached.text, source: 'cache' }
  }

  const bundled = readBundled(path)
  if (bundled !== null) {
    return { ok: true, text: bundled, source: 'bundled', snapshotDate }
  }

  const available = listBundledDocs()
  console.warn(`${LOG_TAG} ${path} unavailable from every tier`)
  return {
    ok: false,
    reason:
      `Document "${path}" could not be retrieved. The documentation host is unreachable and ` +
      `the offline snapshot bundled with this Halo version does not contain it.`,
    available,
  }
}

/** Drop cached documents. Exposed for tests and manual refresh. */
export function clearOfficialDocsCache(): void {
  cache.clear()
}
