/**
 * A remote client (browser or phone) can put a file from its own device into
 * the space's working directory: it lands under its own name, a second file of
 * the same name gets a numbered one, a name can never climb out of the space,
 * and a file over the size limit or abandoned halfway leaves nothing behind.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const space = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../../../src/shared/constants/artifact-upload', () => ({ MAX_UPLOAD_FILE_SIZE: 64 }))
vi.mock('../../../../src/main/http/routes/_shared', async () => {
  const fs = await import('fs')
  const path = await import('path')
  const zlib = await import('zlib')
  return {
    basename: path.basename,
    collectFiles: vi.fn(),
    createFile: vi.fn(),
    createFolder: vi.fn(),
    createGzip: zlib.createGzip,
    createReadStream: fs.createReadStream,
    detectFileType: vi.fn(),
    existsSync: fs.existsSync,
    getWorkingDir: (spaceId: string) => (spaceId === 'space-1' ? space.dir : path.join(space.dir, 'missing')),
    isPathInside: vi.fn(),
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
    validateFilePath: (res: { status: (code: number) => { json: (body: unknown) => void } }, filePath: string) => {
      if (filePath.startsWith(space.dir + path.sep)) return filePath
      res.status(403).json({ success: false, error: 'Access denied' })
      return null
    },
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
})

beforeEach(() => {
  if (space.dir) rmSync(space.dir, { recursive: true, force: true })
  space.dir = mkdtempSync(join(tmpdir(), 'artifact-upload-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

async function upload(name: string | null, body: BodyInit, spaceId = 'space-1'): Promise<{ status: number; body: { success: boolean; data?: { path: string; name: string; size: number }; error?: string; code?: string } }> {
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
  it('saves it under its own name in the working directory, leaving no temp file', async () => {
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

  it('keeps only the last part of a name, so nothing lands outside the space', async () => {
    const result = await upload('../../escape.txt', 'x')
    expect(result.body.data?.path).toBe(join(space.dir, 'escape.txt'))
    expect(readdirSync(space.dir)).toEqual(['escape.txt'])
    const hidden = await upload('..\\..\\.env', 'y')
    expect(hidden.body.data?.path).toBe(join(space.dir, 'env'))
  })

  it('refuses a file over the size limit, declared or not, and keeps nothing of it', async () => {
    expect(await upload('big.bin', 'x'.repeat(65))).toEqual({ status: 413, body: { success: false, error: 'File too large', code: 'TOO_LARGE' } })

    const chunks = ['a'.repeat(40), 'b'.repeat(40)]
    const stream = new ReadableStream({ pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(new TextEncoder().encode(next)); else controller.close() } })
    const streamed = await upload('big.bin', stream)
    expect(streamed).toEqual({ status: 413, body: { success: false, error: 'File too large', code: 'TOO_LARGE' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(readdirSync(space.dir)).toEqual([])
  })

  it('asks for a name and a space that exists', async () => {
    expect((await upload(null, 'x')).status).toBe(400)
    expect((await upload('a.txt', 'x', 'space-unknown')).status).toBe(404)
  })
})
