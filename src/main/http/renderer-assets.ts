/**
 * The built renderer, served to remote browsers.
 *
 * In a packaged app these files live inside app.asar. Opening one as a stream,
 * which is what `express.static` does, makes Electron extract it to a hidden
 * file in the system temp folder and keep using that path; macOS deletes such
 * files after a few days unused, and from then on every page and asset fails
 * until Halo restarts. Reading a whole file goes to the archive itself, so
 * every file is read that way, once, and every response sending it shares that
 * copy: the packaged renderer does not change while Halo runs, so memory stays
 * within the bundle's size however many clients download a file, slowly or at
 * the same time. A repeat visit is answered from the browser's cache through
 * the validators `express.static` sent (a weak ETag of size and mtime, and
 * Last-Modified).
 */

import { readFile, stat, type Stats } from 'fs'
import { extname, join } from 'path'
import type { RequestHandler } from 'express'

/** Errors that mean "no such file here": the request falls through to the SPA shell. */
const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'])

/** Each file's contents, replaced when its size or modification time changes. */
const contents = new Map<string, { size: number; mtimeMs: number; body: Promise<Buffer> }>()

/**
 * The file a request path names under `root`, or null for one that is never
 * served: undecodable, a null byte, or any segment starting with a dot (dotfiles,
 * and `..` climbing out of `root`). A path ending in a slash names its index.html.
 */
export function resolveAssetPath(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const segments = decoded.split(/[\\/]/).filter(Boolean)
  if (segments.some((segment) => segment.startsWith('.'))) return null
  if (segments.length === 0 || decoded.endsWith('/')) segments.push('index.html')
  return join(root, ...segments)
}

function statOf(path: string): Promise<Stats | null> {
  return new Promise((resolve, reject) => {
    stat(path, (error, stats) => {
      if (!error) resolve(stats)
      else if (MISSING.has(error.code ?? '')) resolve(null)
      else reject(error)
    })
  })
}

function contentOf(path: string, stats: Stats): Promise<Buffer> {
  const cached = contents.get(path)
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.body
  const body = new Promise<Buffer>((resolve, reject) => {
    readFile(path, (error, data) => (error ? reject(error) : resolve(data)))
  })
  const entry = { size: stats.size, mtimeMs: stats.mtimeMs, body }
  contents.set(path, entry)
  // A failed read is not kept: the next request reads again.
  body.catch(() => { if (contents.get(path) === entry) contents.delete(path) })
  return body
}

/** GET/HEAD for files under `root`; anything else, and any missing file, goes to `next`. */
export function serveRendererAssets(root: string): RequestHandler {
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const file = resolveAssetPath(root, req.path)
    if (!file) return next()
    try {
      const stats = await statOf(file)
      if (!stats?.isFile()) return next()

      res.setHeader('Cache-Control', 'public, max-age=0')
      res.setHeader('Last-Modified', stats.mtime.toUTCString())
      res.setHeader('ETag', `W/"${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}"`)
      res.type(extname(file) || 'application/octet-stream')
      if (req.fresh) {
        res.status(304).end()
        return
      }

      const body = await contentOf(file, stats)
      res.setHeader('Content-Length', body.length)
      if (req.method === 'HEAD') res.end()
      else res.end(body)
    } catch (error) {
      console.error('[HTTP] Remote asset could not be read', { path: req.path, error })
      next(error)
    }
  }
}
