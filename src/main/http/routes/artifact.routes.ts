/**
 * Artifact REST API routes (remote access).
 * Split from the monolithic routes/index.ts; mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { createWriteStream, mkdirSync, renameSync, unlink } from 'fs'
import {
  basename,
  collectFiles,
  createFile,
  createFolder,
  createGzip,
  createReadStream,
  detectFileType,
  existsSync,
  getSpaceDir,
  getWorkingDir,
  isPathInside,
  join,
  listArtifacts,
  listArtifactsTree,
  loadTreeChildren,
  moveArtifact,
  readArtifactContent,
  reconcileArtifacts,
  renameArtifact,
  saveArtifactContent,
  statSync,
  trashArtifact,
  validateFilePath,
} from './_shared'
import { retainArtifactSpace, releaseArtifactSpace, queryFiles, resolveArtifactPaths } from '../../services/artifact.service'
import { issueDownloadTicket, redeemDownloadTicket } from '../auth/download-ticket'
import { resolveUniquePath, sanitizeFilename } from '../../foundation/file-naming'
import { MAX_UPLOAD_FILE_SIZE } from '../../../shared/constants/artifact-upload'

const DOWNLOAD_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  py: 'text/x-python',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
}

// RFC 6266: an ASCII stand-in for old clients, then the exact UTF-8 name
// that browsers and phones save the file under.
function attachment(fileName: string): string {
  const asciiName = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const utf8Name = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`
}

/**
 * Sends one file as a download. A file that cannot be opened gets an error
 * response; a read that fails after bytes went out can only drop the connection.
 */
function sendFileAttachment(res: Response, filePath: string, size: number): void {
  const fileName = basename(filePath)
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  res.setHeader('Content-Type', DOWNLOAD_TYPES[ext] || 'application/octet-stream')
  res.setHeader('Content-Disposition', attachment(fileName))
  res.setHeader('Content-Length', size)
  createReadStream(filePath)
    .on('error', (error: NodeJS.ErrnoException) => {
      console.error('[Download] Could not read the file:', error.message)
      if (res.headersSent) {
        res.destroy(error)
        return
      }
      res.removeHeader('Content-Disposition')
      res.removeHeader('Content-Length')
      const missing = error.code === 'ENOENT'
      res.status(missing ? 404 : 500).json({ success: false, error: missing ? 'File not found' : 'Could not read the file' })
    })
    .pipe(res)
}

export function registerArtifactRoutes(app: Express): void {
  // ===== Artifact Routes =====
  app.get('/api/spaces/:spaceId/artifacts', async (req: Request, res: Response) => {
    try {
      const rawMaxDepth = req.query.maxDepth
      const parsedMaxDepth = typeof rawMaxDepth === 'string' ? Number.parseInt(rawMaxDepth, 10) : Number.NaN
      const maxDepth = Number.isFinite(parsedMaxDepth) ? Math.max(0, parsedMaxDepth) : 2
      const artifacts = await listArtifacts(req.params.spaceId, maxDepth)
      res.json({ success: true, data: artifacts })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // Best path matches for a typed query (the @ menu)
  app.get('/api/spaces/:spaceId/artifacts/query', async (req: Request, res: Response) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q : ''
      const parsedLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : Number.NaN
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50
      res.json({ success: true, data: await queryFiles(req.params.spaceId, query, limit) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // Which mentioned paths are existing files or folders of the space (links in AI replies)
  app.post('/api/spaces/:spaceId/artifacts/resolve', async (req: Request, res: Response) => {
    try {
      const { paths, baseDir } = req.body ?? {}
      if (!Array.isArray(paths)) {
        res.status(400).json({ success: false, error: 'Missing paths' })
        return
      }
      const data = await resolveArtifactPaths(req.params.spaceId, paths, typeof baseDir === 'string' ? baseDir : undefined)
      res.json({ success: true, data })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // Tree view of artifacts — returns { workspaceRoot, nodes }
  app.get('/api/spaces/:spaceId/artifacts/tree', async (req: Request, res: Response) => {
    try {
      const result = await listArtifactsTree(req.params.spaceId)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // Lazy load children for tree nodes
  app.post('/api/spaces/:spaceId/artifacts/children', async (req: Request, res: Response) => {
    try {
      const { dirPath } = req.body
      if (!dirPath) {
        res.status(400).json({ success: false, error: 'Missing dirPath' })
        return
      }

      const workDir = getWorkingDir(req.params.spaceId)
      if (!isPathInside(dirPath, workDir)) {
        res.status(403).json({ success: false, error: 'Access denied' })
        return
      }

      const children = await loadTreeChildren(req.params.spaceId, dirPath)
      res.json({ success: true, data: children })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // Download single file
  app.get('/api/artifacts/download', async (req: Request, res: Response) => {
    try {
      const validatedPath = validateFilePath(res, req.query.path as string, 'read')
      if (!validatedPath) {
        return
      }

      if (!existsSync(validatedPath)) {
        res.status(404).json({ success: false, error: 'File not found' })
        return
      }

      const stats = statSync(validatedPath)
      const fileName = basename(validatedPath)

      if (stats.isDirectory()) {
        // For directories, create a simple tar.gz stream
        // Note: This is a simplified implementation. For production, use archiver package.
        const files = collectFiles(validatedPath, validatedPath)
        if (files.length === 0) {
          res.status(404).json({ success: false, error: 'Directory is empty' })
          return
        }

        // Set headers for tar.gz download
        res.setHeader('Content-Type', 'application/gzip')
        res.setHeader('Content-Disposition', attachment(`${fileName}.tar.gz`))

        // Create a simple concatenated file stream with headers
        // For a proper implementation, use archiver or tar package
        // This is a fallback that just zips the first file for now
        const gzip = createGzip()
        const firstFile = files[0]
        const readStream = createReadStream(firstFile.fullPath)

        readStream.pipe(gzip).pipe(res)
      } else {
        sendFileAttachment(res, validatedPath, stats.size)
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      console.error('[Download] Error:', err.stack || err.message)
      // The path passed validation but vanished mid-request (check-then-use race).
      // That is a missing resource, not a server fault.
      const status = err.code === 'ENOENT' ? 404 : 500
      res.status(status).json({ success: false, error: err.message })
    }
  })

  // A link for one file that carries a two-minute ticket instead of the access
  // token, so it can be handed to the phone's browser or kept in a download list.
  app.post('/api/artifacts/download-ticket', async (req: Request, res: Response) => {
    try {
      const validatedPath = validateFilePath(res, typeof req.body?.path === 'string' ? req.body.path : undefined, 'read')
      if (!validatedPath) {
        return
      }
      if (!existsSync(validatedPath) || !statSync(validatedPath).isFile()) {
        res.status(404).json({ success: false, error: 'File not found' })
        return
      }
      res.json({ success: true, data: { ticket: issueDownloadTicket(validatedPath) } })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Reached without a token: the ticket is the credential (auth/download-ticket.ts).
  app.get('/api/artifacts/file/:ticket', async (req: Request, res: Response) => {
    const ticketPath = redeemDownloadTicket(req.params.ticket)
    if (!ticketPath) {
      res.status(401).json({ success: false, error: 'This download link has expired' })
      return
    }
    try {
      const validatedPath = validateFilePath(res, ticketPath, 'read')
      if (!validatedPath) {
        return
      }
      const stats = existsSync(validatedPath) ? statSync(validatedPath) : null
      if (!stats?.isFile()) {
        res.status(404).json({ success: false, error: 'File not found' })
        return
      }
      sendFileAttachment(res, validatedPath, stats.size)
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Download all artifacts in a space as zip
  app.get('/api/spaces/:spaceId/artifacts/download-all', async (req: Request, res: Response) => {
    try {
      const { spaceId } = req.params
      const workDir = getWorkingDir(spaceId)

      if (!existsSync(workDir)) {
        res.status(404).json({ success: false, error: 'Space not found' })
        return
      }

      const files = collectFiles(workDir, workDir)
      if (files.length === 0) {
        res.status(404).json({ success: false, error: 'No files to download' })
        return
      }

      // For simplicity, just download the first file if archiver is not available
      // A proper implementation would use archiver to create a zip
      const fileName = spaceId === 'halo-temp' ? 'halo-artifacts' : basename(workDir)
      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Disposition', attachment(`${fileName}.tar.gz`))

      // Stream the first file with gzip as a demo
      // TODO: Use archiver for proper zip support
      const gzip = createGzip()
      const firstFile = files[0]
      const readStream = createReadStream(firstFile.fullPath)
      readStream.pipe(gzip).pipe(res)
    } catch (error) {
      console.error('[Download All] Error:', error)
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Read artifact content (Content Canvas fallback for remote mode)
  app.get('/api/artifacts/content', async (req: Request, res: Response) => {
    try {
      const validatedPath = validateFilePath(res, req.query.path as string, 'read')
      if (!validatedPath) {
        return
      }

      if (!existsSync(validatedPath)) {
        res.status(404).json({ success: false, error: 'File not found' })
        return
      }

      const result = await readArtifactContent(validatedPath)
      res.json({ success: true, data: result })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Save artifact content (remote mode edit)
  app.post('/api/artifacts/save', async (req: Request, res: Response) => {
    try {
      const { path: filePath, content } = req.body
      const validatedPath = validateFilePath(res, filePath)
      if (!validatedPath) return

      if (typeof content !== 'string') {
        res.status(400).json({ success: false, error: 'Invalid content' })
        return
      }

      saveArtifactContent(validatedPath, content)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Detect file type (remote mode Canvas fallback)
  app.get('/api/artifacts/detect-type', async (req: Request, res: Response) => {
    try {
      const validatedPath = validateFilePath(res, req.query.path as string, 'read')
      if (!validatedPath) return

      if (!existsSync(validatedPath)) {
        res.status(404).json({ success: false, error: 'File not found' })
        return
      }

      const info = detectFileType(validatedPath)
      res.json({ success: true, data: info })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })


  // ===== File Operations Routes (Create, Rename, Delete, Move) =====

  // Create file — frontend sends (parentPath, name), backend constructs full path
  app.post('/api/spaces/:spaceId/artifacts/file', async (req: Request, res: Response) => {
    try {
      const { parentPath, name, content } = req.body as { parentPath?: string; name?: string; content?: string }
      if (!name) {
        res.status(400).json({ success: false, error: 'Missing name' })
        return
      }
      const resolvedPath = await createFile(req.params.spaceId, parentPath || '', name, content || '')
      res.json({ success: true, data: { path: resolvedPath } })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // One file from a remote client's device into the space's working directory.
  // The body is the file itself, streamed into a temp dotfile beside its target
  // and renamed once whole, so the file's own name never holds half an upload.
  app.post('/api/spaces/:spaceId/artifacts/upload', (req: Request, res: Response) => {
    const { spaceId } = req.params
    const requested = typeof req.query.name === 'string' ? req.query.name.split(/[\\/]/).pop()?.trim() ?? '' : ''
    if (!requested) {
      res.status(400).json({ success: false, error: 'Missing file name' })
      return
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_FILE_SIZE) {
      console.warn('[Upload] Refused a file over the size limit', { spaceId, bytes: declared })
      res.status(413).json({ success: false, error: 'File too large', code: 'TOO_LARGE' })
      return
    }
    const workDir = getSpaceDir(spaceId)
    if (!workDir) {
      console.warn('[Upload] Refused an upload to an unknown space', { spaceId })
      res.status(404).json({ success: false, error: 'Space not found' })
      return
    }
    // The built-in space's folder is Halo's own and made on first use, as the agent does.
    if (spaceId === 'halo-temp') mkdirSync(workDir, { recursive: true })
    if (!existsSync(workDir)) {
      console.warn('[Upload] The space has no working directory to save into', { spaceId })
      res.status(409).json({ success: false, error: 'The working directory of this space is not available', code: 'NO_WORKING_DIR' })
      return
    }
    // The directory is checked, since the file does not exist yet; the name
    // is a single segment, so the file lands directly inside it.
    if (!validateFilePath(res, workDir, 'write')) {
      return
    }
    const name = sanitizeFilename(requested)

    const partial = join(workDir, `.${randomUUID()}.upload`)
    const out = createWriteStream(partial, { flags: 'wx' })
    let received = 0
    let failed = false
    const fail = (status: number, error: string, code?: string) => {
      if (failed) return
      failed = true
      req.unpipe(out)
      out.destroy()
      // Removed only once closed: a file still being opened would be created
      // again after an earlier removal.
      const discard = () => unlink(partial, () => {})
      if (out.closed) discard()
      else out.once('close', discard)
      if (res.headersSent) return
      // Stop receiving the rest once the answer is out.
      res.setHeader('Connection', 'close')
      res.on('finish', () => req.destroy())
      res.status(status).json({ success: false, error, ...(code ? { code } : {}) })
    }
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_UPLOAD_FILE_SIZE && !failed) {
        console.warn('[Upload] Stopped a file going over the size limit', { spaceId, bytes: received })
        fail(413, 'File too large', 'TOO_LARGE')
      }
    })
    req.on('close', () => {
      if (req.complete || failed) return
      console.warn('[Upload] The client left before the file was complete', { spaceId, bytes: received })
      fail(400, 'Upload interrupted')
    })
    out.on('error', (error) => {
      console.error('[Upload] Could not write the file:', error.message)
      fail(500, 'Could not save the file')
    })
    // Moved into place once closed, so no handle is left open on the file.
    out.on('close', () => {
      if (failed) return
      if (!out.writableFinished) {
        fail(500, 'Could not save the file')
        return
      }
      let target: string
      try {
        // A free name is picked and taken in one step, so two uploads of one
        // name finishing together never land on the same file.
        target = resolveUniquePath(workDir, name)
        renameSync(partial, target)
      } catch (error) {
        console.error('[Upload] Could not move the file into place:', (error as Error).message)
        unlink(partial, () => {})
        res.status(500).json({ success: false, error: 'Could not save the file' })
        return
      }
      console.log('[Upload] Saved a file from a remote client', { spaceId, name: basename(target), bytes: received })
      res.json({ success: true, data: { path: target, name: basename(target), size: received } })
    })
    req.pipe(out)
  })

  // Create folder — frontend sends (parentPath, name), backend constructs full path
  app.post('/api/spaces/:spaceId/artifacts/folder', async (req: Request, res: Response) => {
    try {
      const { parentPath, name } = req.body as { parentPath?: string; name?: string }
      if (!name) {
        res.status(400).json({ success: false, error: 'Missing name' })
        return
      }
      const resolvedPath = await createFolder(req.params.spaceId, parentPath || '', name)
      res.json({ success: true, data: { path: resolvedPath } })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // A client starts / stops showing a space (keeps or frees its cache and watcher)
  app.post('/api/spaces/:spaceId/artifacts/retain', async (req: Request, res: Response) => {
    const { clientId } = req.body as { clientId?: string }
    if (typeof clientId !== 'string' || !clientId) {
      res.status(400).json({ success: false, error: 'Missing clientId' })
      return
    }
    try {
      res.json({ success: true, data: await retainArtifactSpace(req.params.spaceId, clientId) })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/spaces/:spaceId/artifacts/release', async (req: Request, res: Response) => {
    const { clientId } = req.body as { clientId?: string }
    if (typeof clientId !== 'string' || !clientId) {
      res.status(400).json({ success: false, error: 'Missing clientId' })
      return
    }
    try {
      await releaseArtifactSpace(req.params.spaceId, clientId)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Reconcile artifact cache against filesystem (push + pull recovery)
  app.post('/api/spaces/:spaceId/artifacts/reconcile', async (req: Request, res: Response) => {
    try {
      await reconcileArtifacts(req.params.spaceId)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Delete file or folder (move to trash)
  app.delete('/api/spaces/:spaceId/artifacts', async (req: Request, res: Response) => {
    try {
      const { path: targetPath } = req.body as { path?: string }
      if (!targetPath) {
        res.status(400).json({ success: false, error: 'Missing path' })
        return
      }
      await trashArtifact(req.params.spaceId, targetPath)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Rename file or folder
  app.post('/api/spaces/:spaceId/artifacts/rename', async (req: Request, res: Response) => {
    try {
      const { oldPath, newName } = req.body as { oldPath?: string; newName?: string }
      if (!oldPath || !newName) {
        res.status(400).json({ success: false, error: 'Missing oldPath or newName' })
        return
      }
      await renameArtifact(req.params.spaceId, oldPath, newName)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Move file or folder — frontend sends (oldPath, newParentPath), backend constructs destination
  app.post('/api/spaces/:spaceId/artifacts/move', async (req: Request, res: Response) => {
    try {
      const { oldPath, newParentPath } = req.body as { oldPath?: string; newParentPath?: string }
      if (!oldPath) {
        res.status(400).json({ success: false, error: 'Missing oldPath' })
        return
      }
      const resolvedPath = await moveArtifact(req.params.spaceId, oldPath, newParentPath || '')
      res.json({ success: true, data: { path: resolvedPath } })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

}
