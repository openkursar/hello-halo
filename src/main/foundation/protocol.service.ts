/**
 * Protocol Service - Custom protocol registration for secure local resource access
 *
 * halo-file:// — local files as subresources for the app renderer, where
 * Chromium blocks file:// from localhost (dev) / file (production) origins:
 * ImageViewer, MarkdownViewer's embedded images, the store's entry icons, and
 * the fallback HTML preview's `<base href="halo-file://<dir>/">`.
 * - <img src="halo-file:///path/to/image.png">
 *
 * halo-preview:// — the HTML preview's own origin. Each opened preview gets a
 * random host mapped to the HTML file's directory, so the page:
 * - is cross-site to the app: an out-of-process frame with no preload bridge
 *   and no access to the app window or its storage;
 * - resolves relative CSS/JS/images/fetches natively, confined to that
 *   directory tree (traversal and symlinks out of it are refused);
 * - is offered only for a file inside a space (`siteDirs`): a generated
 *   multi-file page there needs its own files. A file elsewhere (Downloads,
 *   Desktop, a mounted drive) shares its folder with unrelated files, so it is
 *   previewed under browser file rules instead (the caller's srcdoc fallback:
 *   sibling images and styles display, script cannot read other files);
 * - never serves dot-files or dot-directories (.ssh, .env, .git …), and is not
 *   offered for a directory that is broad enough to contain them: the
 *   filesystem root, the home directory or its ancestors, or anything holding
 *   the Halo data or app-data directories (the caller falls back to srcdoc);
 * - runs under its own CSP (PREVIEW_DOCUMENT_POLICY): its directory plus
 *   https: CDN scripts/styles/images/fonts, no network connections, never
 *   halo-file:, other previews, or the app.
 *
 * An embedded browser page is not subject to those restrictions and loads
 * file:// itself, so nothing it renders (the PDF viewer) goes through here.
 *
 * Security (halo-file):
 * - Only file:// URLs are allowed, no remote URLs pass through.
 * - The scheme is not privileged, so `fetch()` rejects it; the app CSP
 *   (`connect-src`) blocks XHR to it and (`frame-src`) blocks framing it.
 * - Every response carries `Content-Security-Policy: sandbox`, which is
 *   ignored for subresources but makes a halo-file:// document scriptless.
 *   Without it, an HTML file reached through a navigation that some future
 *   policy allows could XHR any other local path.
 */

import { protocol, net, session } from 'electron'
import { randomBytes } from 'crypto'
import { realpathSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path'
import { pathToFileURL } from 'url'

const DOCUMENT_POLICY = 'sandbox'

export const PREVIEW_SCHEME = 'halo-preview'

/**
 * CSP of every halo-preview response. 'self' is the preview's own directory;
 * https: lets generated pages load CDN scripts, styles, images and fonts.
 * The page cannot connect, fetch or post out: connect-src and form-action stay
 * at 'self'. Data can still leave in the GET URL of an https image, script or
 * frame it loads, so what bounds exposure is what the page can read — its own
 * directory only (no halo-file:, no other halo-preview host, no dot-files).
 * Also absent: http: (mixed content) and plugins.
 */
export const PREVIEW_DOCUMENT_POLICY = [
  "default-src 'self' https: data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  "media-src 'self' https: data: blob:",
  "connect-src 'self'",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

/** What a previewed page can have stored under its origin. */
const PREVIEW_STORAGES = ['cookies', 'filesystem', 'indexdb', 'localstorage', 'serviceworkers', 'cachestorage'] as const

/** Open previews kept at once; the oldest is forgotten past this (its tab has long been closed). */
const MAX_PREVIEW_ROOTS = 64

/** Preview host -> the real path of the directory it serves. */
const previewRoots = new Map<string, string>()

/** Adds the inert-document policy to a file response. */
export function withInertDocumentPolicy(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', DOCUMENT_POLICY)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

/** Local filesystem path addressed by a halo-file:// URL. */
export function haloFileUrlToPath(url: string): string {
  // The renderer appends a ?v=<token> cache-buster to force <img> reloads when a
  // file is rewritten in place; strip any query/hash before resolving the real path.
  const raw = url.replace('halo-file://', '')
  return decodeURIComponent(raw.split(/[?#]/)[0])
}

const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin'
const canonical = (path: string) => (caseInsensitiveFs ? path.toLowerCase() : path)

function isSameOrInside(parent: string, child: string): boolean {
  const p = canonical(parent)
  const c = canonical(child)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** Where a preview site may be served from. */
export interface PreviewScope {
  /** Directories a site may never be, contain or be an ancestor of (home, Halo data, app data). */
  protectedDirs: readonly string[]
  /** Directories a site must lie within (the spaces). */
  siteDirs: readonly string[]
}

/**
 * Whether a directory may be served as a preview site. It must lie within one
 * of `siteDirs`. Refused even there: the filesystem root, and any directory
 * that is, contains, or is an ancestor of one of `protectedDirs` — a page
 * there could read credentials and data that live beside the file.
 * Paths must already be real paths.
 */
export function isPreviewRootAllowed(root: string, scope: PreviewScope): boolean {
  if (dirname(root) === root) return false
  if (scope.protectedDirs.some((dir) => isSameOrInside(root, dir))) return false
  return scope.siteDirs.some((dir) => isSameOrInside(dir, root))
}

/** Whether a path has a segment that names a hidden file or directory. */
function hasHiddenSegment(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment.startsWith('.') && segment !== '.')
}

/**
 * Serve `filePath`'s directory under a fresh preview origin and return the
 * URL of the file there. Released by `closePreview(host)`. Throws when the
 * directory is not one to serve (see isPreviewRootAllowed) or the file itself
 * is hidden; the caller previews without an origin instead.
 */
export function openPreview(filePath: string, scope: PreviewScope): { url: string; host: string } {
  const root = realpathSync(dirname(filePath))
  if (hasHiddenSegment(basename(filePath))) throw new Error('Hidden files are not previewed from their directory')
  const realScope: PreviewScope = {
    protectedDirs: scope.protectedDirs.map(safeRealpath),
    siteDirs: scope.siteDirs.map(safeRealpath),
  }
  if (!isPreviewRootAllowed(root, realScope)) {
    throw new Error('Only a file inside a space, below its protected directories, is served as a preview site')
  }
  const host = randomBytes(16).toString('hex')
  previewRoots.set(host, root)
  if (previewRoots.size > MAX_PREVIEW_ROOTS) {
    closePreview(previewRoots.keys().next().value as string)
  }
  return { url: `${PREVIEW_SCHEME}://${host}/${encodeURIComponent(basename(filePath))}`, host }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Forget a preview and erase what its page stored. Every preview is a fresh
 * origin, so its localStorage / IndexedDB / cache would otherwise stay on
 * disk forever. (A frame cannot get its own non-persistent partition — that
 * belongs to the whole window — so the storage is cleared per origin.)
 */
export function closePreview(host: string): void {
  if (!previewRoots.delete(host)) return
  session.defaultSession
    // Only per-origin data: without a list Electron also clears session-wide
    // caches (shader cache and the like) for every closed preview.
    .clearStorageData({ origin: `${PREVIEW_SCHEME}://${host}`, storages: [...PREVIEW_STORAGES] })
    .catch((error) => console.warn('[Protocol] Failed to clear preview storage:', error))
}

/**
 * The real path a preview URL path names, or null when it is not a file
 * inside `root` — including `..` smuggled in encoded and symlinks that lead
 * out of the tree.
 */
export function resolvePreviewFile(root: string, urlPathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || hasHiddenSegment(decoded)) return null
  const isInside = (path: string) => {
    const rel = relative(root, path)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }
  const target = resolve(root, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`)
  if (!isInside(target)) return null
  try {
    const real = realpathSync(target)
    // A symlink inside the tree may lead to a hidden directory inside it.
    return isInside(real) && !hasHiddenSegment(relative(root, real)) && statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

async function servePreview(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  const url = new URL(request.url)
  const root = previewRoots.get(url.host)
  if (!root) return new Response(null, { status: 404 })
  const file = resolvePreviewFile(root, url.pathname)
  if (!file) return new Response(null, { status: 404 })

  const response = await net.fetch(pathToFileURL(file).href)
  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', PREVIEW_DOCUMENT_POLICY)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * Grant scheme privileges. Electron accepts this only once and only before
 * the app is ready.
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    // standard: a real origin per host, so relative URLs and same-origin fetches work;
    // secure: https: subresources are not mixed content.
    { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])
}

/**
 * Register custom protocols for secure local resource access
 * Must be called after app.whenReady()
 */
export function registerProtocols(): void {
  // halo-file:// - Proxy to file:// for local resources
  // Chromium blocks file:// from localhost/app origins, this bypasses that
  protocol.handle('halo-file', async (request) => {
    const response = await net.fetch(`file://${haloFileUrlToPath(request.url)}`)
    return withInertDocumentPolicy(response)
  })

  protocol.handle(PREVIEW_SCHEME, servePreview)

  console.log('[Protocol] Registered halo-file:// and halo-preview:// protocols')
}
