/**
 * Where the staged path reads its signed description, and what it accepts.
 *
 * A release server serves descriptions under /staged/. A GitHub repository can
 * only carry flat release assets, served as application/octet-stream — which
 * the content-type gate must not mistake for a server's HTML page.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const netFetch = vi.fn()
vi.mock('electron', () => ({
  app: { getVersion: () => '3.0.0', quit: vi.fn() },
  net: { fetch: (...args: unknown[]) => netFetch(...args) },
}))

vi.mock('../../../../src/main/foundation/product-config', () => ({
  loadProductConfig: () => ({ dataFolderName: 'halo' }),
  getUpdateChannel: () => 'stable',
  getUpdateManifestPublicKey: () => 'a-key',
}))

vi.mock('../../../../src/main/services/updater/staged/helper', () => ({
  EXPECTED_HELPER_VERSION: 1,
  readHelperVersion: async () => 1,
  launchApply: vi.fn(),
  launchRollback: vi.fn(),
  stagePackage: vi.fn(),
}))
vi.mock('../../../../src/main/services/updater/staged/download', () => ({ downloadPackage: vi.fn() }))
vi.mock('../../../../src/main/services/updater/staged/failed-versions', () => ({
  hasFailedBefore: () => false,
}))
vi.mock('../../../../src/main/services/updater/staged/layout', () => ({
  resolveLayout: () => ({ workDir: '/install/.halo-update' }),
  confirmFileFor: vi.fn(),
  hasRoomToStage: () => true,
  HELPER_RUN_PREFIX: 'halo-update-helper-',
}))

const readStagedManifest = vi.fn((_body: string) => ({ version: '3.0.1', package: { size: 1 } }))
vi.mock('../../../../src/main/services/updater/staged/manifest', () => ({
  readStagedManifest: (body: string) => readStagedManifest(body),
}))

const ENVELOPE = '{"payload":"e30=","signature":"c2ln","keyId":"default"}'

function respond(contentType: string, status = 200): Response {
  return new Response(ENVELOPE, { status, headers: { 'content-type': contentType } })
}

const realArch = process.arch

describe('staged description feed', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    netFetch.mockReset()
    readStagedManifest.mockClear()
  })
  afterEach(() => {
    Object.defineProperty(process, 'arch', { value: realArch, configurable: true })
  })

  it('reads the flat asset of the latest GitHub release, served as octet-stream', async () => {
    netFetch.mockResolvedValue(respond('application/octet-stream'))
    const { checkForStagedUpdate } = await import('../../../../src/main/services/updater/staged')

    const manifest = await checkForStagedUpdate({ kind: 'github', owner: 'openkursar', repo: 'hello-halo' })

    expect(netFetch).toHaveBeenCalledWith(
      'https://github.com/openkursar/hello-halo/releases/latest/download/staged-win-x64.json'
    )
    expect(readStagedManifest).toHaveBeenCalledWith(ENVELOPE)
    expect(manifest?.version).toBe('3.0.1')
  })

  it('reads /staged/ on a release server', async () => {
    netFetch.mockResolvedValue(respond('application/json; charset=utf-8'))
    const { checkForStagedUpdate } = await import('../../../../src/main/services/updater/staged')

    await checkForStagedUpdate({ kind: 'generic', url: 'http://updates.example:18080/' })

    expect(netFetch).toHaveBeenCalledWith('http://updates.example:18080/staged/win-x64.json')
    expect(readStagedManifest).toHaveBeenCalled()
  })

  it('declines quietly when the server answers with its HTML page', async () => {
    netFetch.mockResolvedValue(respond('text/html'))
    const { checkForStagedUpdate } = await import('../../../../src/main/services/updater/staged')

    const manifest = await checkForStagedUpdate({ kind: 'generic', url: 'http://updates.example:18080' })

    expect(manifest).toBeNull()
    // Reaching the verifier would report a server that predates staged
    // updates as a forged signature.
    expect(readStagedManifest).not.toHaveBeenCalled()
  })

  it('declines when the release has no description asset', async () => {
    netFetch.mockResolvedValue(respond('text/plain', 404))
    const { checkForStagedUpdate } = await import('../../../../src/main/services/updater/staged')

    const manifest = await checkForStagedUpdate({ kind: 'github', owner: 'openkursar', repo: 'hello-halo' })

    expect(manifest).toBeNull()
    expect(readStagedManifest).not.toHaveBeenCalled()
  })
})
