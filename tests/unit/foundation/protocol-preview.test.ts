/**
 * The HTML preview origin serves exactly one directory tree per preview:
 * nothing above it, nothing a symlink points to outside it, and every
 * response carries the preview's own CSP.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const handlers = new Map<string, (request: Request) => Promise<Response>>()
type ClearOptions = { origin: string; storages?: string[] }
const clearStorageData = vi.fn(async (_options: ClearOptions) => {})
vi.mock('electron', () => ({
  session: { defaultSession: { clearStorageData: (options: ClearOptions) => clearStorageData(options) } },
  protocol: {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) => handlers.set(scheme, handler),
    registerSchemesAsPrivileged: vi.fn(),
  },
  net: {
    fetch: async (url: string) => new Response(readFileSync(fileURLToPath(url)), { headers: { 'Content-Type': 'text/plain' } }),
  },
}))

const {
  closePreview,
  openPreview,
  isPreviewRootAllowed,
  PREVIEW_DOCUMENT_POLICY,
  registerProtocols,
  resolvePreviewFile,
} = await import('../../../src/main/foundation/protocol.service')

let base: string
let site: string

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'halo-preview-')))
  site = join(base, 'site')
  mkdirSync(join(site, 'assets'), { recursive: true })
  mkdirSync(join(base, 'outside'))
  writeFileSync(join(site, 'index.html'), '<p>hi</p>')
  writeFileSync(join(site, 'assets', 'app.css'), 'body{}')
  mkdirSync(join(site, '.ssh'))
  writeFileSync(join(site, '.ssh', 'id_rsa'), 'private key')
  writeFileSync(join(site, '.env'), 'TOKEN=1')
  writeFileSync(join(site, 'assets', '.hidden.css'), 'x')
  symlinkSync(join(site, '.ssh'), join(site, 'visible-ssh'))
  writeFileSync(join(base, 'secret.txt'), 'above')
  writeFileSync(join(base, 'outside', 'secret.txt'), 'outside')
  symlinkSync(join(base, 'outside'), join(site, 'escape'))
  symlinkSync(join(site, 'assets'), join(site, 'alias'))
  registerProtocols()
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('resolvePreviewFile', () => {
  it('serves files in the tree', () => {
    expect(resolvePreviewFile(site, '/index.html')).toBe(join(site, 'index.html'))
    expect(resolvePreviewFile(site, '/assets/app.css')).toBe(join(site, 'assets', 'app.css'))
  })

  it('follows a symlink that stays inside the tree', () => {
    expect(resolvePreviewFile(site, '/alias/app.css')).toBe(join(site, 'assets', 'app.css'))
  })

  it.each([
    ['plain traversal', '/../secret.txt'],
    ['encoded traversal', '/..%2fsecret.txt'],
    ['double-encoded dots', '/%2e%2e/secret.txt'],
    ['symlink out of the tree', '/escape/secret.txt'],
    ['a dot-directory', '/.ssh/id_rsa'],
    ['an encoded dot-directory', '/%2essh/id_rsa'],
    ['a dot-file', '/.env'],
    ['a dot-file in a subdirectory', '/assets/.hidden.css'],
    ['a dot-directory reached through a visible symlink', '/visible-ssh/id_rsa'],
    ['the directory itself', '/'],
    ['a directory', '/assets'],
    ['a missing file', '/nope.html'],
    ['a NUL byte', '/index.html%00.png'],
    ['malformed escapes', '/%E0%A4%A'],
  ])('refuses %s', (_label, pathname) => {
    expect(resolvePreviewFile(site, pathname)).toBeNull()
  })

  it('refuses an absolute path smuggled in encoded', () => {
    expect(resolvePreviewFile(site, `/${encodeURIComponent(join(base, 'secret.txt'))}`)).toBeNull()
  })
})

describe('preview origin', () => {
  const serve = (url: string) => handlers.get('halo-preview')!(new Request(url))

  it('opens a fresh host per preview, pointing at the file', () => {
    const a = openPreview(join(site, 'index.html'), [])
    const b = openPreview(join(site, 'index.html'), [])
    expect(a.url).toMatch(/^halo-preview:\/\/[0-9a-f]{32}\/index\.html$/)
    expect(a.host).not.toBe(b.host)
  })

  it('serves the file with the preview policy and no caching', async () => {
    const { url } = openPreview(join(site, 'index.html'), [])
    const res = await serve(url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>hi</p>')
    expect(res.headers.get('Content-Security-Policy')).toBe(PREVIEW_DOCUMENT_POLICY)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('refuses paths outside its directory and hosts it never opened or already closed', async () => {
    const { host } = openPreview(join(site, 'index.html'), [])
    expect((await serve(`halo-preview://${host}/escape/secret.txt`)).status).toBe(404)
    expect((await serve(`halo-preview://${'0'.repeat(32)}/index.html`)).status).toBe(404)
    closePreview(host)
    expect((await serve(`halo-preview://${host}/index.html`)).status).toBe(404)
  })

  it('only answers reads', async () => {
    const { host } = openPreview(join(site, 'index.html'), [])
    const res = await handlers.get('halo-preview')!(new Request(`halo-preview://${host}/index.html`, { method: 'POST', body: 'x' }))
    expect(res.status).toBe(405)
  })

  it('keeps the page away from local files and the app, while allowing its own tree and https CDN assets', () => {
    expect(PREVIEW_DOCUMENT_POLICY).not.toMatch(/halo-file|halo-preview|file:|http:(?!\/)|\*/)
    expect(PREVIEW_DOCUMENT_POLICY).toMatch(/script-src 'self'[^;]*https:/)
    expect(PREVIEW_DOCUMENT_POLICY).toMatch(/style-src 'self'[^;]*https:/)
    expect(PREVIEW_DOCUMENT_POLICY).toMatch(/img-src 'self'[^;]*https:/)
    expect(PREVIEW_DOCUMENT_POLICY).toMatch(/font-src 'self'[^;]*https:/)
    expect(PREVIEW_DOCUMENT_POLICY).toMatch(/object-src 'none'/)
  })

  it('lets script read only its own directory: no fetch, XHR, WebSocket or form post to the network', () => {
    const directive = (name: string) => new RegExp(`(?:^|; )${name} ([^;]*)`).exec(PREVIEW_DOCUMENT_POLICY)?.[1]
    expect(directive('connect-src')).toBe("'self'")
    expect(directive('form-action')).toBe("'self'")
  })

  it('serves nothing hidden, even when asked through the host', async () => {
    const { host } = openPreview(join(site, 'index.html'), [])
    for (const p of ['/.ssh/id_rsa', '/.env', '/visible-ssh/id_rsa']) {
      expect((await serve(`halo-preview://${host}${p}`)).status, p).toBe(404)
    }
  })

  it('does not open a hidden file as the preview page', () => {
    writeFileSync(join(site, '.page.html'), '<p>')
    expect(() => openPreview(join(site, '.page.html'), [])).toThrow(/Hidden/)
  })
})

describe('preview storage', () => {
  it("erases the page's storage when its preview closes, once", () => {
    clearStorageData.mockClear()
    const { host } = openPreview(join(site, 'index.html'), [])
    closePreview(host)
    closePreview(host)
    expect(clearStorageData).toHaveBeenCalledTimes(1)
    const [options] = clearStorageData.mock.calls[0]
    expect(options.origin).toBe(`halo-preview://${host}`)
    // Per-origin stores only — never session-wide caches such as the shader cache.
    expect([...(options.storages ?? [])].sort()).toEqual(
      ['cachestorage', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'serviceworkers', 'websql']
    )
  })

  it('erases the storage of previews dropped by the open-preview cap', () => {
    const first = openPreview(join(site, 'index.html'), [])
    clearStorageData.mockClear()
    const opened = [first.host]
    for (let i = 0; i < 64; i++) opened.push(openPreview(join(site, 'index.html'), []).host)
    expect(clearStorageData).toHaveBeenCalledWith(expect.objectContaining({ origin: `halo-preview://${first.host}` }))
    for (const host of opened) closePreview(host)
  })

  it('keeps closing when clearing fails', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    clearStorageData.mockRejectedValueOnce(new Error('busy'))
    const { host } = openPreview(join(site, 'index.html'), [])
    expect(() => closePreview(host)).not.toThrow()
    await new Promise(r => setTimeout(r, 0))
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('which directories may be served', () => {
  // Paths only; nothing here touches the disk except the last test.
  const home = '/fake/users/me'
  const dataDir = join(home, '.halo')
  const userData = join(home, 'Library', 'Application Support', 'halo')
  const protectedDirs = [home, dataDir, userData]

  it('refuses the filesystem root', () => {
    expect(isPreviewRootAllowed('/', protectedDirs)).toBe(false)
  })

  it('refuses the home directory and every ancestor of it', () => {
    expect(isPreviewRootAllowed(home, protectedDirs)).toBe(false)
    expect(isPreviewRootAllowed(join(home, '..'), protectedDirs)).toBe(false)
    expect(isPreviewRootAllowed(dirname(dirname(home)), protectedDirs)).toBe(false)
  })

  it('refuses a directory that contains the Halo data or app-data directory', () => {
    expect(isPreviewRootAllowed(join(home, 'Library'), [userData])).toBe(false)
    expect(isPreviewRootAllowed(join(home, 'Library', 'Application Support'), [userData])).toBe(false)
    expect(isPreviewRootAllowed(dataDir, [dataDir])).toBe(false)
  })

  it('allows project directories below home and directories beside it', () => {
    expect(isPreviewRootAllowed(join(home, 'projects', 'site'), protectedDirs)).toBe(true)
    expect(isPreviewRootAllowed(join(home, 'Documents'), protectedDirs)).toBe(true)
    expect(isPreviewRootAllowed(join(dirname(home), 'home-other'), protectedDirs)).toBe(true)
  })

  it("allows Halo's own artifact folder, which lives inside the data directory", () => {
    expect(isPreviewRootAllowed(join(dataDir, 'temp', 'artifacts'), protectedDirs)).toBe(true)
  })

  it('is not fooled by a sibling with the same name prefix', () => {
    expect(isPreviewRootAllowed(home + '-backup', protectedDirs)).toBe(true)
  })

  it('refuses to open a preview for such a directory', () => {
    mkdirSync(join(base, 'home', 'proj'), { recursive: true })
    writeFileSync(join(base, 'home', 'report.html'), '<p>')
    writeFileSync(join(base, 'home', 'proj', 'report.html'), '<p>')
    const guarded = [join(base, 'home')]
    expect(() => openPreview(join(base, 'home', 'report.html'), guarded)).toThrow(/too broad/)
    writeFileSync(join(base, 'report-at-base.html'), '<p>')
    expect(() => openPreview(join(base, 'report-at-base.html'), guarded)).toThrow(/too broad/)
    expect(openPreview(join(base, 'home', 'proj', 'report.html'), guarded).url).toMatch(/^halo-preview:\/\//)
  })
})
