/**
 * The built renderer, served to remote browsers.
 *
 * In a packaged app these files live inside app.asar. Opening one as a stream,
 * which is what `express.static` does, makes Electron extract it to a hidden
 * file in the system temp folder and keep using that path; macOS deletes such
 * files after a few days unused, and from then on every page and asset fails
 * until Halo restarts. Reading a whole file goes to the archive itself, so
 * every file is read that way. Responses sending the same file at the same
 * time, however slowly, share one copy, and it is dropped once the last of
 * them is done: memory follows what is being sent, not how many clients there
 * are, and nothing stays behind when they are served. A repeat visit is
 * answered from the browser's cache through the validators `express.static`
 * sent (a weak ETag of size and mtime, and Last-Modified).
 */

import { readFile, stat, type Stats } from 'fs'
import { extname, join } from 'path'
import type { RequestHandler, Response } from 'express'

/** Errors that mean "no such file here": the request falls through to the SPA shell. */
const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'])

/** Files being sent right now, one copy per version, with how many responses use it. */
const sending = new Map<string, { version: string; body: Promise<Buffer>; users: number }>()

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

/** How many file copies are held for responses right now (diagnostics). */
export function rendererAssetCopies(): number {
  return sending.size
}

/** The file's contents for one response, shared with the others sending it until all have closed. */
function contentFor(path: string, stats: Stats, res: Response): Promise<Buffer> {
  const version = `${stats.size}:${stats.mtimeMs}`
  let entry = sending.get(path)
  if (!entry || entry.version !== version) {
    const body = new Promise<Buffer>((resolve, reject) => {
      readFile(path, (error, data) => (error ? reject(error) : resolve(data)))
    })
    entry = { version, body, users: 0 }
    sending.set(path, entry)
  }
  const shared = entry
  shared.users++
  res.once('close', () => {
    if (--shared.users === 0 && sending.get(path) === shared) sending.delete(path)
  })
  return shared.body
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
      // A client gone while the file was checked would hold its share forever:
      // its close has already fired, so the release would never run.
      if (res.destroyed) return

      const body = await contentFor(file, stats, res)
      res.setHeader('Content-Length', body.length)
      if (req.method === 'HEAD') res.end()
      else res.end(body)
    } catch (error) {
      console.error('[HTTP] Remote asset could not be read', { path: req.path, error })
      next(error)
    }
  }
}
