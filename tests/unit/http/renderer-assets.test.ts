/**
 * Remote browsers get the built renderer by whole-file reads only. Opening a
 * file inside app.asar as a stream makes Electron extract it to a temp file
 * that macOS later deletes, after which every page and asset failed until a
 * restart; a whole-file read goes to the archive itself. Responses sending the
 * same file at the same time share one copy, which is dropped once the last of
 * them is done, so slow downloads cannot pile up copies and nothing stays in
 * memory afterwards. The validators the browser caches against stay those
 * `express.static` sent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import express from 'express'
import { get, type IncomingMessage, type Server } from 'http'

const io = vi.hoisted(() => ({ readFile: 0, stat: 0, streamed: 0, failNextRead: false, holdStat: null as Promise<void> | null }))
vi.mock('fs', async (original) => {
  const real = await original<typeof import('fs')>()
  return {
    ...real,
    readFile: ((...args: Parameters<typeof real.readFile>) => {
      io.readFile++
      if (io.failNextRead) {
        io.failNextRead = false
        const callback = args[args.length - 1] as (error: Error) => void
        setImmediate(() => callback(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })))
        return
      }
      return (real.readFile as (...a: unknown[]) => void)(...args)
    }) as typeof real.readFile,
    stat: ((...args: Parameters<typeof real.stat>) => {
      io.stat++
      const run = () => (real.stat as (...a: unknown[]) => void)(...args)
      if (io.holdStat) void io.holdStat.then(run)
      else run()
    }) as typeof real.stat,
    open: ((...args: Parameters<typeof real.open>) => { io.streamed++; return (real.open as (...a: unknown[]) => void)(...args) }) as typeof real.open,
    createReadStream: ((...args: Parameters<typeof real.createReadStream>) => { io.streamed++; return real.createReadStream(...args) }) as typeof real.createReadStream,
  }
})

import { rendererAssetCopies, resolveAssetPath, serveRendererAssets } from '../../../src/main/http/renderer-assets'

let root: string
let server: Server
let base: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'renderer-assets-'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Halo</title>')
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log("halo")')
  writeFileSync(join(root, 'assets', 'qcms.wasm'), Buffer.from([0, 97, 115, 109]))
  writeFileSync(join(root, 'assets', 'Adobe-GB1-UCS2.bcmap'), Buffer.from([1, 2, 3]))
  writeFileSync(join(root, '.env'), 'SECRET=1')

  const app = express()
  app.use(serveRendererAssets(root))
  app.use((_req, res) => { res.type('html').send('spa shell') })
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  io.readFile = 0
  io.stat = 0
  io.streamed = 0
})

describe('remote renderer assets', () => {
  it('serves a file by reading it whole, with the validators express.static sent', async () => {
    const response = await fetch(`${base}/assets/index-abc123.js`)
    const stats = statSync(join(root, 'assets', 'index-abc123.js'))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('console.log("halo")')
    expect(response.headers.get('content-type')).toMatch(/javascript/)
    expect(response.headers.get('cache-control')).toBe('public, max-age=0')
    expect(response.headers.get('etag')).toBe(`W/"${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}"`)
    expect(response.headers.get('last-modified')).toBe(stats.mtime.toUTCString())
    expect(io.readFile).toBe(1)
    expect(io.streamed).toBe(0)
  })

  it('answers a revalidation from the file\'s metadata alone, and HEAD without a body', async () => {
    const first = await fetch(`${base}/assets/index-abc123.js`)
    io.readFile = 0
    // A browser revalidating its cached copy; fetch() would add `Cache-Control: no-cache`, which forbids a 304.
    const status = await new Promise<number>((resolve, reject) => {
      get(`${base}/assets/index-abc123.js`, { headers: { 'If-None-Match': first.headers.get('etag')! } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }).on('error', reject)
    })
    expect(status).toBe(304)
    expect(io.readFile).toBe(0)

    const head = await fetch(`${base}/assets/index-abc123.js`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String('console.log("halo")'.length))
    expect(await head.text()).toBe('')
    expect(io.streamed).toBe(0)
  })

  it('serves the page at the root and types binary assets', async () => {
    expect(await (await fetch(`${base}/`)).text()).toBe('<!doctype html><title>Halo</title>')
    expect((await fetch(`${base}/assets/qcms.wasm`)).headers.get('content-type')).toBe('application/wasm')
    expect((await fetch(`${base}/assets/Adobe-GB1-UCS2.bcmap`)).headers.get('content-type')).toBe('application/octet-stream')
    expect(io.streamed).toBe(0)
  })

  it('leaves missing files, folders, dotfiles and other methods to the SPA shell', async () => {
    for (const path of ['/conversations/123', '/assets', '/.env', '/assets/missing.js']) {
      const response = await fetch(`${base}${path}`)
      expect(await response.text(), path).toBe('spa shell')
    }
    expect(await (await fetch(`${base}/assets/index-abc123.js`, { method: 'POST' })).text()).toBe('spa shell')
  })
})

describe('one copy per file', () => {
  it('shares one copy with every response still sending it, and drops it once all are done', async () => {
    const size = 8 * 1024 * 1024
    writeFileSync(join(root, 'assets', 'big.wasm'), Buffer.alloc(size, 7))
    // A slow client: it takes the headers, then stops reading, so its response stays open.
    const slow = await new Promise<IncomingMessage>((resolve, reject) => {
      get(`${base}/assets/big.wasm`, resolve).on('error', reject)
    })
    slow.pause()
    expect((await (await fetch(`${base}/assets/big.wasm`)).arrayBuffer()).byteLength).toBe(size)
    expect(io.readFile).toBe(1)

    let received = 0
    slow.on('data', (chunk: Buffer) => { received += chunk.length })
    await new Promise<void>((resolve) => { slow.on('end', resolve); slow.resume() })
    expect(received).toBe(size)
    await new Promise((resolve) => setImmediate(resolve))
    expect((await (await fetch(`${base}/assets/big.wasm`)).arrayBuffer()).byteLength).toBe(size)
    expect(io.readFile).toBe(2)
  })

  it('holds nothing for a client that left while the file was still being checked', async () => {
    writeFileSync(join(root, 'assets', 'left-early.js'), 'never sent')
    let releaseStat!: () => void
    io.holdStat = new Promise<void>((resolve) => { releaseStat = resolve })
    const request = get(`${base}/assets/left-early.js`)
    request.on('error', () => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    request.destroy()
    await new Promise((resolve) => setTimeout(resolve, 20))
    io.holdStat = null
    releaseStat()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rendererAssetCopies()).toBe(0)
    expect(io.readFile).toBe(0)
  })

  it('reads a file again once it changed', async () => {
    writeFileSync(join(root, 'assets', 'shared-2.js'), 'before')
    expect(await (await fetch(`${base}/assets/shared-2.js`)).text()).toBe('before')
    writeFileSync(join(root, 'assets', 'shared-2.js'), 'after the change')
    expect(await (await fetch(`${base}/assets/shared-2.js`)).text()).toBe('after the change')
    expect(io.readFile).toBe(2)
  })

  it('keeps no failed read', async () => {
    writeFileSync(join(root, 'assets', 'shared-3.js'), 'eventually')
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    io.failNextRead = true
    expect((await fetch(`${base}/assets/shared-3.js`)).status).toBe(500)
    expect(await (await fetch(`${base}/assets/shared-3.js`)).text()).toBe('eventually')
    expect(io.readFile).toBe(2)
    quiet.mockRestore()
  })
})

describe('resolveAssetPath', () => {
  it('maps request paths under the root, a trailing slash to its index.html', () => {
    expect(resolveAssetPath('/app/renderer', '/assets/a%20b.js')).toBe(join('/app/renderer', 'assets', 'a b.js'))
    expect(resolveAssetPath('/app/renderer', '/')).toBe(join('/app/renderer', 'index.html'))
    expect(resolveAssetPath('/app/renderer', '/pdfjs/')).toBe(join('/app/renderer', 'pdfjs', 'index.html'))
  })

  it('never names a file outside the root, a dotfile, or an undecodable path', () => {
    for (const path of ['/../secret.txt', '/assets/../../secret', '/a/%2e%2e/%2e%2e/x', '/..\\..\\x', '/.env', '/assets/.hidden/x.js', '/a%00.js', '/%E0%A4%A.js']) {
      expect(resolveAssetPath('/app/renderer', path), path).toBeNull()
    }
  })
})
