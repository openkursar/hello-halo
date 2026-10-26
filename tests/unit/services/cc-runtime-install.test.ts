import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CcRuntimeConfig } from '../../../src/shared/types/cc-runtime'

const mocks = vi.hoisted(() => ({
  config: { agent: { sdkEngine: 'halo', ccRuntime: {} as CcRuntimeConfig } },
  save: true,
  fetch: vi.fn(),
  probe: vi.fn()
}))
vi.mock('../../../src/main/foundation/config.service', () => ({
  getHaloDir: () => join(globalThis.__HALO_TEST_DIR__, '.halo'),
  getConfig: () => structuredClone(mocks.config),
  saveConfig: (patch: { agent: { ccRuntime: CcRuntimeConfig } }) => {
    if (mocks.save) mocks.config.agent.ccRuntime = structuredClone(patch.agent.ccRuntime)
  }
}))
vi.mock('../../../src/main/services/proxy-fetch', () => ({ proxyFetch: mocks.fetch }))
vi.mock('../../../src/main/services/cc-runtime/probe', () => ({
  checkInstallation: mocks.probe,
  readKnownInstallation: () => null,
  launchForInstallation: vi.fn()
}))

import { cancelCcInstall, configureCcRuntime, discoverAndSelectCcRuntime, getCcRuntimeStatus, installCcRuntime, lookupCcRelease, selectCcInstallation } from '../../../src/main/services/cc-runtime'
import { clearReleaseCache } from '../../../src/main/services/cc-runtime/releases'

const artifact = Buffer.from('native release fixture bytes')
const checksum = createHash('sha256').update(artifact).digest('hex')
const platform = `${process.platform}-${process.arch}`

function downloads(hash = checksum) {
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/manifest.json')) return new Response(JSON.stringify({ version: '2.1.89', platforms: { [platform]: { checksum: hash, size: artifact.length } } }))
    return new Response(artifact)
  })
}

beforeEach(() => {
  clearReleaseCache()
  mocks.config = { agent: { sdkEngine: 'halo', ccRuntime: { installVersion: '2.1.89' } } }
  mocks.save = true
  mocks.fetch.mockReset()
  mocks.probe.mockReset().mockImplementation(async (path: string) => ({
    path, resolvedPath: path, version: '2.1.89', kind: 'native', compatibility: 'verified', recommended: true, managed: true, checkedAt: new Date().toISOString()
  }))
})

describe('managed CC installation', () => {
  it('checks the manifest checksum, publishes atomically, and preserves other agent settings', async () => {
    downloads()
    const result = await installCcRuntime()
    expect(await readFile(result.path)).toEqual(artifact)
    expect(result.path).not.toContain('.install-')
    expect(mocks.config.agent).toMatchObject({ sdkEngine: 'halo', ccRuntime: { selectedPath: result.path } })
    expect((await getCcRuntimeStatus()).install.phase).toBe('complete')
    expect((await readdir(join(globalThis.__HALO_TEST_DIR__, '.halo', 'runtimes', 'claude-code'))).some(name => name.startsWith('.install-'))).toBe(false)
  })

  it('keeps the prior selection and removes staging when integrity fails', async () => {
    mocks.config.agent.ccRuntime.selectedPath = '/existing/claude'
    downloads('0'.repeat(64))
    await expect(installCcRuntime()).rejects.toMatchObject({ code: 'checksum-mismatch' })
    expect(mocks.config.agent.ccRuntime.selectedPath).toBe('/existing/claude')
    expect(mocks.probe).not.toHaveBeenCalled()
    expect((await readdir(join(globalThis.__HALO_TEST_DIR__, '.halo', 'runtimes', 'claude-code'))).filter(name => name !== 'catalog.json')).toEqual([])
    clearReleaseCache()
    downloads()
    await expect(installCcRuntime()).resolves.toMatchObject({ compatibility: 'verified' })
  })

  it('supports a private mirror without ever running a downloaded installer script', async () => {
    await configureCcRuntime({ sources: [{ id: 'intranet', name: 'Company mirror', baseUrl: 'https://mirror.example.test/cc/' }], sourceId: 'intranet' })
    downloads()
    await installCcRuntime()
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual([
      'https://mirror.example.test/cc/2.1.89/manifest.json',
      `https://mirror.example.test/cc/2.1.89/${platform}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`
    ])
  })

  it('follows a secure CDN redirect explicitly', async () => {
    downloads()
    const serving = mocks.fetch.getMockImplementation()!
    mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
      expect(options.redirect).toBe('manual')
      if (url === 'https://downloads.claude.ai/claude-code-releases/2.1.89/manifest.json') {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/manifest.json' } })
      }
      return serving(url, options)
    })
    await installCcRuntime()
    expect(mocks.fetch.mock.calls.some(call => call[0] === 'https://cdn.example.test/manifest.json')).toBe(true)
  })

  it.each(['http://mirror.example.test/manifest.json', 'file:///tmp/manifest.json', 'https://user:secret@example.test/manifest.json'])(
    'rejects unsafe HTTPS-source redirects before fetching %s', async location => {
      mocks.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location } }))
      await expect(installCcRuntime()).rejects.toMatchObject({ code: 'invalid-source' })
      expect(mocks.fetch).toHaveBeenCalledTimes(1)
      expect(mocks.probe).not.toHaveBeenCalled()
    }
  )

  it('allows an explicitly configured HTTP intranet source and bounds redirect loops', async () => {
    await configureCcRuntime({ sources: [{ id: 'intranet', name: 'Local mirror', baseUrl: 'http://mirror.example.test/cc' }], sourceId: 'intranet' })
    downloads()
    await installCcRuntime()
    expect(mocks.fetch.mock.calls[0][0]).toBe('http://mirror.example.test/cc/2.1.89/manifest.json')
    mocks.fetch.mockReset().mockResolvedValue(new Response(null, { status: 302, headers: { location: '/loop' } }))
    await expect(installCcRuntime({ version: '2.1.90' })).rejects.toMatchObject({ code: 'source-unreachable' })
    expect(mocks.fetch).toHaveBeenCalledTimes(6)
  })

  it('cancels a live transfer without changing selection and rejects a second concurrent install', async () => {
    mocks.config.agent.ccRuntime.selectedPath = '/existing/claude'
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    mocks.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      started()
    }))
    const installing = installCcRuntime()
    await ready
    await expect(installCcRuntime()).rejects.toMatchObject({ code: 'install-busy' })
    expect(cancelCcInstall()).toBe(true)
    await expect(installing).rejects.toMatchObject({ code: 'cancelled' })
    expect(mocks.config.agent.ccRuntime.selectedPath).toBe('/existing/claude')
    expect((await getCcRuntimeStatus()).install.phase).toBe('cancelled')
    downloads()
    await expect(installCcRuntime()).resolves.toMatchObject({ compatibility: 'verified' })
  })

  it('classifies a truncated metadata connection as a download failure', async () => {
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('connection closed')) }
    })))
    await expect(installCcRuntime()).rejects.toMatchObject({ code: 'source-unreachable' })
  })

  it('does not claim selection succeeded when persistence failed', async () => {
    mocks.save = false
    await expect(selectCcInstallation('/valid/claude')).rejects.toMatchObject({ code: 'storage-failed' })
  })

  it('reuses an installed exact version completely offline without another binary request', async () => {
    downloads()
    const installed = await installCcRuntime()
    mocks.fetch.mockReset().mockRejectedValue(new Error('offline'))
    clearReleaseCache()
    expect((await installCcRuntime()).path).toBe(installed.path)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect((await getCcRuntimeStatus()).installations).toEqual(expect.arrayContaining([expect.objectContaining({ path: installed.path, version: '2.1.89' })]))
  })

  it('indexes an older managed directory and reuses it after manifest-only source validation', async () => {
    const directory = join(globalThis.__HALO_TEST_DIR__, '.halo', 'runtimes', 'claude-code', `2.1.89-${platform}-${checksum.slice(0, 16)}`)
    await mkdir(directory, { recursive: true })
    const path = join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude')
    await writeFile(path, artifact)
    mocks.fetch.mockImplementation(async (url: string) => {
      if (!url.endsWith('/manifest.json')) throw new Error('binary must not be requested')
      return new Response(JSON.stringify({ version: '2.1.89', platforms: { [platform]: { checksum, size: artifact.length } } }))
    })
    const initial = await getCcRuntimeStatus()
    expect(initial.installations).toEqual([expect.objectContaining({ path, compatibility: 'unchecked' })])
    expect(mocks.probe).not.toHaveBeenCalled()
    expect((await installCcRuntime()).path).toBe(path)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not reuse or report the old checksum when a changed mirror serves different bytes for the same version', async () => {
    await configureCcRuntime({ sources: [{ id: 'custom', name: 'Original mirror', baseUrl: 'https://original.example.test/cc' }], sourceId: 'custom' })
    downloads()
    const first = await installCcRuntime()
    await configureCcRuntime({ sources: [{ id: 'custom', name: 'Changed mirror', baseUrl: 'https://changed.example.test/cc' }], sourceId: 'custom' })
    const replacement = Buffer.from('different bytes for the same reported version')
    const replacementChecksum = createHash('sha256').update(replacement).digest('hex')
    mocks.fetch.mockReset().mockImplementation(async (url: string) => url.endsWith('/manifest.json')
      ? new Response(JSON.stringify({ version: '2.1.89', platforms: { [platform]: { checksum: replacementChecksum, size: replacement.length } } }))
      : new Response(replacement))
    expect((await lookupCcRelease({ version: '2.1.89' })).installedPath).toBeUndefined()
    const changed = await installCcRuntime()
    expect(changed.path).not.toBe(first.path)
    expect(await readFile(first.path)).toEqual(artifact)
    expect(await readFile(changed.path)).toEqual(replacement)
    expect(mocks.fetch.mock.calls.filter(call => !call[0].endsWith('/manifest.json'))).toHaveLength(1)
    clearReleaseCache()
    mocks.fetch.mockReset().mockRejectedValue(new Error('offline'))
    expect((await installCcRuntime()).path).toBe(changed.path)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('validates a changed source with metadata but reuses identical installed bytes', async () => {
    downloads()
    const first = await installCcRuntime()
    await configureCcRuntime({ sources: [{ id: 'mirror', name: 'Mirror', baseUrl: 'https://same-release.example.test/cc' }], sourceId: 'mirror' })
    mocks.fetch.mockReset().mockImplementation(async (url: string) => {
      if (!url.endsWith('/manifest.json')) throw new Error('binary must not be requested')
      return new Response(JSON.stringify({ version: '2.1.89', platforms: { [platform]: { checksum, size: artifact.length } } }))
    })
    expect((await installCcRuntime()).path).toBe(first.path)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('persists a failed local selection without changing the previously selected runtime', async () => {
    const path = join(globalThis.__HALO_TEST_DIR__, 'local-claude.cjs')
    await writeFile(path, 'local fixture')
    mocks.probe.mockResolvedValueOnce({ path, version: '2.1.89', kind: 'javascript', managed: false, compatibility: 'verified', recommended: true, checkedAt: new Date().toISOString() })
    await selectCcInstallation(path)
    mocks.config.agent.ccRuntime.selectedPath = '/previous/claude'
    await rm(path)
    mocks.probe.mockResolvedValueOnce({ path, managed: false, compatibility: 'unavailable', recommended: false, issue: 'not-found', checkedAt: new Date().toISOString() })
    await expect(selectCcInstallation(path)).rejects.toMatchObject({ code: 'not-found' })
    expect(mocks.config.agent.ccRuntime.selectedPath).toBe('/previous/claude')
    vi.resetModules()
    const restarted = await import('../../../src/main/services/cc-runtime/catalog')
    expect((await restarted.getCatalogSnapshot()).installations.find(item => item.path === path)).toMatchObject({ compatibility: 'unavailable', issue: 'not-found' })
  })

  it('resolves a channel but reuses its installed binary without downloading it again', async () => {
    downloads()
    const installed = await installCcRuntime()
    clearReleaseCache()
    mocks.fetch.mockReset().mockImplementation(async (url: string) => {
      if (url.endsWith('/stable')) return new Response('2.1.89')
      if (url.endsWith('/manifest.json')) return new Response(JSON.stringify({ version: '2.1.89', platforms: { [platform]: { checksum, size: artifact.length } } }))
      throw new Error('binary must not be requested')
    })
    expect((await installCcRuntime({ version: 'stable' })).path).toBe(installed.path)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a damaged binary even if its interface checker still responds', async () => {
    downloads()
    const installed = await installCcRuntime()
    await writeFile(installed.path, 'damaged bytes')
    clearReleaseCache()
    mocks.fetch.mockReset().mockRejectedValue(new Error('offline'))
    await expect(installCcRuntime()).rejects.toMatchObject({ code: 'source-unreachable' })
    const status = await getCcRuntimeStatus()
    expect(status.installations.find(item => item.path === installed.path)).toMatchObject({ compatibility: 'unavailable', issue: 'checksum-mismatch' })
    expect(await readFile(installed.path, 'utf8')).toBe('damaged bytes')
    downloads()
    const repaired = await installCcRuntime()
    expect(repaired.path).not.toBe(installed.path)
    expect(await readFile(repaired.path)).toEqual(artifact)
    expect(await readFile(installed.path, 'utf8')).toBe('damaged bytes')
    expect(mocks.config.agent.ccRuntime.selectedPath).toBe(repaired.path)
    expect((await getCcRuntimeStatus()).installations).toHaveLength(2)
  })

  it('does not allow preferences to bypass executable validation', async () => {
    mocks.config.agent.ccRuntime.selectedPath = '/checked/claude'
    await configureCcRuntime({ selectedPath: '/unchecked/program', installVersion: 'latest' } as never)
    expect(mocks.config.agent.ccRuntime.selectedPath).toBe('/checked/claude')
    expect(mocks.config.agent.ccRuntime.installVersion).toBe('latest')
  })

  it('honors cancellation during the final post-publication check', async () => {
    downloads()
    mocks.config.agent.ccRuntime.selectedPath = '/existing/claude'
    const defaultProbe = mocks.probe.getMockImplementation()!
    mocks.probe.mockImplementation(async (path, options) => {
      if (!path.includes('.install-')) {
        cancelCcInstall()
        expect(options.signal.aborted).toBe(true)
      }
      return defaultProbe(path)
    })
    await expect(installCcRuntime()).rejects.toMatchObject({ code: 'cancelled' })
    expect(mocks.config.agent.ccRuntime.selectedPath).toBe('/existing/claude')
  })

  it('preserves a newer deliberate selection made while a download was running', async () => {
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/manifest.json')) return new Response(JSON.stringify({ version: '2.1.89', platforms: { [platform]: { checksum, size: artifact.length } } }))
      started()
      await wait
      return new Response(artifact)
    })
    const installing = installCcRuntime()
    await ready
    await selectCcInstallation('/user/preferred/claude')
    release()
    await installing
    expect(mocks.config.agent.ccRuntime.selectedPath).toBe('/user/preferred/claude')
  })

  it('bounds migration detection and never selects an aborted result', async () => {
    mocks.config.agent.ccRuntime.selectedPath = '/existing/claude'
    mocks.probe.mockImplementation((_path, options) => new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ compatibility: 'unavailable', issue: 'cancelled' }), { once: true })))
    const start = Date.now()
    expect(await discoverAndSelectCcRuntime({ deadlineMs: 25 })).toBeNull()
    expect(Date.now() - start).toBeLessThan(500)
    expect(mocks.config.agent.ccRuntime.selectedPath).toBe('/existing/claude')
  })

  it('does no subprocess or network work when reading settings and rejects unsafe source values', async () => {
    await getCcRuntimeStatus()
    expect(mocks.probe).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
    await expect(configureCcRuntime({ sources: [{ id: 'bad', name: 'Bad', baseUrl: 'https://user:password@example.test' }] })).rejects.toMatchObject({ code: 'invalid-source' })
    await expect(configureCcRuntime({ installVersion: '../latest' })).rejects.toMatchObject({ code: 'invalid-version' })
    await expect(configureCcRuntime({ sourceId: 'missing' })).rejects.toMatchObject({ code: 'invalid-source' })
  })
})
