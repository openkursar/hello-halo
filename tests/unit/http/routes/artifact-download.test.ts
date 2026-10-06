/**
 * A downloaded artifact keeps its name on every client: Content-Disposition
 * carries an ASCII stand-in and the exact UTF-8 name (RFC 6266), which desktop
 * and mobile browsers save under. A bare percent-encoded `filename` was saved
 * literally by every browser that does not guess at decoding it.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
    getWorkingDir: vi.fn(),
    isPathInside: vi.fn(),
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
    validateFilePath: (_res: unknown, filePath: string) => filePath,
  }
})

vi.mock('../../../../src/main/services/artifact.service', () => ({
  retainArtifactSpace: vi.fn(),
  releaseArtifactSpace: vi.fn(),
  queryFiles: vi.fn(),
  resolveArtifactPaths: vi.fn(),
}))

import { registerArtifactRoutes } from '../../../../src/main/http/routes/artifact.routes'

let dir: string
let server: Server
let base: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'artifact-download-'))
  const app = express()
  registerArtifactRoutes(app)
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

async function download(name: string, content: string): Promise<{ response: Response; body: string }> {
  const file = join(dir, name)
  writeFileSync(file, content)
  const response = await fetch(`${base}/api/artifacts/download?path=${encodeURIComponent(file)}`)
  return { response, body: await response.text() }
}

describe('GET /api/artifacts/download', () => {
  it('names a CJK file exactly, with an ASCII stand-in for old clients', async () => {
    const { response, body } = await download('报告 v2.docx', 'docx-bytes')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="__ v2.docx"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20v2.docx`,
    )
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-length')).toBe('10')
    expect(body).toBe('docx-bytes')
  })

  it('encodes accents and the characters RFC 5987 reserves, keeping the type', async () => {
    const { response } = await download(`résumé (1)'s.pdf`, '%PDF')
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="r_sum_ (1)'s.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29%27s.pdf`,
    )
  })
})
