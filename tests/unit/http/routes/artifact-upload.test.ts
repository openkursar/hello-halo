/**
 * A remote client (browser or phone) can put a file from its own device into
 * the space's working directory: it lands under its own name, a second file of
 * the same name gets a numbered one, a name can never climb out of the space,
 * and a file over the size limit or abandoned halfway leaves nothing behind.
 *
 * The real path guard runs: only where the spaces live is set here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const space = vi.hoisted(() => ({ root: '', dir: '', temp: '', outside: '' }))

vi.mock('../../../../src/shared/constants/artifact-upload', () => ({ MAX_UPLOAD_FILE_SIZE: 64 }))
vi.mock('../../../../src/main/services/space.service', () => ({ getAllSpacePaths: () => [space.dir, space.temp] }))
vi.mock('../../../../src/main/services/tlon', () => ({ getTlonRoot: () => '/nonexistent/knowledge-base' }))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getTeamFolderRoot: () => '/nonexistent/team-folders' }))
vi.mock('../../../../src/main/http/routes/_shared', async () => {
  const fs = await import('fs')
  const path = await import('path')
  const zlib = await import('zlib')
  const guard = await vi.importActual<typeof import('../../../../src/main/http/routes/_path-guard')>('../../../../src/main/http/routes/_path-guard')
  // As space.service answers: '' for a space it does not know.
  const spaceDirs = (): Record<string, string> => ({
    'space-1': space.dir,
    'halo-temp': path.join(space.temp, 'artifacts'),
    'space-gone': path.join(space.root, 'unplugged-drive'),
    'space-outside': space.outside,
  })
  return {
    basename: path.basename,
    collectFiles: vi.fn(),
    createFile: vi.fn(),
    createFolder: vi.fn(),
    createGzip: zlib.createGzip,
    createReadStream: fs.createReadStream,
    detectFileType: vi.fn(),
    existsSync: fs.existsSync,
    getSpaceDir: (spaceId: string) => spaceDirs()[spaceId] ?? '',
    getWorkingDir: vi.fn(),
    isPathInside: guard.isPathInside,
    join: path.join,
    listArtifacts: vi.fn(),
    listArtifactsTree: vi.fn(),
    loadTreeChildren: vi.fn(),
    moveArtifact: vi.fn(),
    readArtifactContent: vi.fn(),
    reconcileArtifacts: vi.fn(),
    renameArtifact: vi.fn(),
    saveArtifactContent: vi.fn(),
    statSync: fs.statSync,
    trashArtifact: vi.fn(),
    validateFilePath: guard.validateFilePath,
  }
})
vi.mock('../../../../src/main/services/artifact.service', () => ({
  retainArtifactSpace: vi.fn(),
  releaseArtifactSpace: vi.fn(),
  queryFiles: vi.fn(),
  resolveArtifactPaths: vi.fn(),
}))

import { registerArtifactRoutes } from '../../../../src/main/http/routes/artifact.routes'

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  registerArtifactRoutes(app)
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(space.root, { recursive: true, force: true })
})

beforeEach(() => {
  if (space.root) rmSync(space.root, { recursive: true, force: true })
  space.root = mkdtempSync(join(tmpdir(), 'artifact-upload-'))
  space.dir = join(space.root, 'space')
  space.temp = join(space.root, 'halo-temp')
  space.outside = join(space.root, 'outside')
  for (const dir of [space.dir, space.temp, space.outside]) mkdirSync(dir)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

type UploadResult = { status: number; body: { success: boolean; data?: { path: string; name: string; size: number }; error?: string; code?: string } }

async function upload(name: string | null, body: BodyInit, spaceId = 'space-1'): Promise<UploadResult> {
  const query = name === null ? '' : `?name=${encodeURIComponent(name)}`
  const response = await fetch(`${base}/api/spaces/${spaceId}/artifacts/upload${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit)
  return { status: response.status, body: await response.json() }
}

describe('uploading a file into a space', () => {
  it('saves a new file under its own name in the working directory, leaving no temp file', async () => {
    const result = await upload('会议纪要.pdf', 'pdf-bytes')
    expect(result.status).toBe(200)
    expect(result.body.data).toEqual({ path: join(space.dir, '会议纪要.pdf'), name: '会议纪要.pdf', size: 9 })
    expect(readFileSync(join(space.dir, '会议纪要.pdf'), 'utf-8')).toBe('pdf-bytes')
    expect(readdirSync(space.dir)).toEqual(['会议纪要.pdf'])
  })

  it('numbers a second file of the same name instead of overwriting the first', async () => {
    await upload('notes.txt', 'first')
    const second = await upload('notes.txt', 'second')
    expect(second.body.data?.name).toBe('notes (1).txt')
    expect(readFileSync(join(space.dir, 'notes.txt'), 'utf-8')).toBe('first')
    expect(readFileSync(join(space.dir, 'notes (1).txt'), 'utf-8')).toBe('second')
  })

  it('gives two uploads of one name sent together a file each', async () => {
    const results = await Promise.all([upload('same.txt', 'one'), upload('same.txt', 'two')])
    expect(results.map((result) => result.body.data?.name).sort()).toEqual(['same (1).txt', 'same.txt'])
    expect(readdirSync(space.dir).map((name) => readFileSync(join(space.dir, name), 'utf-8')).sort()).toEqual(['one', 'two'])
  })

  it('keeps only the last part of a name, so nothing lands outside the space', async () => {
    const result = await upload('../../escape.txt', 'x')
    expect(result.body.data?.path).toBe(join(space.dir, 'escape.txt'))
    expect(readdirSync(space.dir)).toEqual(['escape.txt'])
    const hidden = await upload('..\\..\\.env', 'y')
    expect(hidden.body.data?.path).toBe(join(space.dir, 'env'))
    expect(readdirSync(space.root).sort()).toEqual(['halo-temp', 'outside', 'space'])
  })

  it('refuses a file over the size limit, declared or not, and keeps nothing of it', async () => {
    expect(await upload('big.bin', 'x'.repeat(65))).toEqual({ status: 413, body: { success: false, error: 'File too large', code: 'TOO_LARGE' } })

    const chunks = ['a'.repeat(40), 'b'.repeat(40)]
    const stream = new ReadableStream({ pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(new TextEncoder().encode(next)); else controller.close() } })
    const streamed = await upload('big.bin', stream)
    expect(streamed).toEqual({ status: 413, body: { success: false, error: 'File too large', code: 'TOO_LARGE' } })
    await vi.waitFor(() => expect(readdirSync(space.dir)).toEqual([]))
  })

  it('drops an upload the client abandons halfway, leaving nothing behind', async () => {
    const controller = new AbortController()
    let firstChunkTaken!: () => void
    const taken = new Promise<void>((resolve) => { firstChunkTaken = resolve })
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('partial')) },
      pull() { firstChunkTaken(); return new Promise<void>(() => {}) },
    })
    const pending = fetch(`${base}/api/spaces/space-1/artifacts/upload?name=video.mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: stream,
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit).catch(() => null)
    await taken
    await vi.waitFor(() => expect(readdirSync(space.dir)).toHaveLength(1))
    controller.abort()
    await pending
    await vi.waitFor(() => expect(readdirSync(space.dir)).toEqual([]))
  })
})

describe('where an upload may go', () => {
  it('asks for a name, and refuses a space that does not exist', async () => {
    expect((await upload(null, 'x')).status).toBe(400)
    expect(await upload('a.txt', 'x', 'space-unknown')).toEqual({ status: 404, body: { success: false, error: 'Space not found' } })
    expect(console.warn).toHaveBeenCalledWith('[Upload] Refused an upload to an unknown space', { spaceId: 'space-unknown' })
    expect(readdirSync(space.temp)).toEqual([])
  })

  it('refuses a space whose working directory is gone, creating nothing in its place', async () => {
    const result = await upload('a.txt', 'x', 'space-gone')
    expect(result.status).toBe(409)
    expect(result.body.code).toBe('NO_WORKING_DIR')
    expect(existsSync(join(space.root, 'unplugged-drive'))).toBe(false)
  })

  it('makes the built-in space\'s own folder on its first upload', async () => {
    const result = await upload('a.txt', 'x', 'halo-temp')
    expect(result.status).toBe(200)
    expect(result.body.data?.path).toBe(join(space.temp, 'artifacts', 'a.txt'))
  })

  it('refuses a working directory that lies outside every space', async () => {
    expect(await upload('a.txt', 'x', 'space-outside')).toEqual({ status: 403, body: { success: false, error: 'Access denied' } })
    expect(readdirSync(space.outside)).toEqual([])
  })
})
