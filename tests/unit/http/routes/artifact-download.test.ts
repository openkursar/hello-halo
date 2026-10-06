/**
 * A downloaded artifact keeps its name on every client: Content-Disposition
 * carries an ASCII stand-in and the exact UTF-8 name (RFC 6266), which desktop
 * and mobile browsers save under. A bare percent-encoded `filename` was saved
 * literally by every browser that does not guess at decoding it.
 *
 * Links handed to a browser carry a ticket for one file instead of the token:
 * the ticket link serves exactly that file until the ticket expires.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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

async function issue(path: string): Promise<{ status: number; ticket?: string; error?: string }> {
  const response = await fetch(`${base}/api/artifacts/download-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  const body = await response.json() as { data?: { ticket: string }; error?: string }
  return { status: response.status, ticket: body.data?.ticket, error: body.error }
}

describe('ticket download links', () => {
  it('serve the one file a ticket was issued for, under its exact name, until it expires', async () => {
    const report = join(dir, '季度报告.docx')
    const notes = join(dir, 'notes.txt')
    writeFileSync(report, 'report-bytes')
    writeFileSync(notes, 'notes-bytes')
    const reportTicket = (await issue(report)).ticket!
    const notesTicket = (await issue(notes)).ticket!

    const first = await fetch(`${base}/api/artifacts/file/${reportTicket}`)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-disposition')).toBe(
      `attachment; filename="____.docx"; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A.docx`,
    )
    expect(await first.text()).toBe('report-bytes')
    // The app's web view fetches the link first, then the system browser fetches it again.
    expect(await (await fetch(`${base}/api/artifacts/file/${reportTicket}`)).text()).toBe('report-bytes')
    expect(await (await fetch(`${base}/api/artifacts/file/${notesTicket}`)).text()).toBe('notes-bytes')

    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121_000)
    try {
      expect((await fetch(`${base}/api/artifacts/file/${reportTicket}`)).status).toBe(401)
    } finally {
      later.mockRestore()
    }
  })

  it('refuse an unknown ticket, and issue none for a missing file or a folder', async () => {
    expect((await fetch(`${base}/api/artifacts/file/${'x'.repeat(43)}`)).status).toBe(401)
    expect(await issue(join(dir, 'gone.txt'))).toMatchObject({ status: 404, ticket: undefined })
    mkdirSync(join(dir, 'folder'))
    expect(await issue(join(dir, 'folder'))).toMatchObject({ status: 404, ticket: undefined })
  })
})
