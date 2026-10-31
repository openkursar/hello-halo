/**
 * How the release checks find a file inside app.asar.
 *
 * The asar listing is always '/'-separated, while engine paths are built with
 * the host's path.join. On a Windows build machine a packaged engine inside
 * the asar would otherwise read as missing and stop the release.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
// @ts-expect-error plain .mjs helper without declarations
import { asarEntryPath, asarList } from '../../scripts/release/lib.mjs'

const requireCjs = createRequire(import.meta.url)
const { ENGINE_RUNTIMES, engineArtifactPaths } = requireCjs('../../scripts/engine-runtimes.cjs')
const asar = requireCjs('@electron/asar') as { createPackage: (src: string, dest: string) => Promise<void> }

const engineIds = Object.keys(ENGINE_RUNTIMES).filter((id) => ENGINE_RUNTIMES[id].packageId)

describe('asarEntryPath', () => {
  it('turns a Windows path into the listing form', () => {
    expect(asarEntryPath('node_modules\\@openai\\codex-sdk\\package.json', '\\')).toBe('node_modules/@openai/codex-sdk/package.json')
    expect(asarEntryPath('\\product.json', '\\')).toBe('product.json')
  })

  it('leaves a POSIX path as it is', () => {
    expect(asarEntryPath('node_modules/@openai/codex-sdk/package.json', '/')).toBe('node_modules/@openai/codex-sdk/package.json')
    expect(asarEntryPath('/product.json', '/')).toBe('product.json')
  })

  it.each(engineIds)('finds the %s engine manifest as a Windows build machine names it', (id) => {
    const packageId: string = ENGINE_RUNTIMES[id].packageId
    const windowsPath = path.win32.join('node_modules', ...packageId.split('/'), 'package.json')
    expect(asarEntryPath(windowsPath, '\\')).toBe(`node_modules/${packageId}/package.json`)
  })
})

describe('engine manifests inside a real asar', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('every bundled engine package is found in the listing', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-asar-entry-'))
    const src = path.join(dir, 'app')
    for (const id of engineIds) {
      const { manifestPath } = engineArtifactPaths(ENGINE_RUNTIMES[id])
      fs.mkdirSync(path.join(src, path.dirname(manifestPath)), { recursive: true })
      fs.writeFileSync(path.join(src, manifestPath), '{}')
    }
    const archive = path.join(dir, 'app.asar')
    await asar.createPackage(src, archive)
    const listing = new Set(asarList(archive))
    for (const id of engineIds) {
      expect(listing.has(asarEntryPath(engineArtifactPaths(ENGINE_RUNTIMES[id]).manifestPath))).toBe(true)
    }
  })
})
