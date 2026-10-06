/**
 * What a build owes the staged Windows update path.
 *
 * A release that enables staged updates but ships no signed description does
 * not fail anywhere a person would see: every client quietly keeps the slow
 * installer path. These rules are what turn that into a build failure.
 */

import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import { join } from 'path'
// @ts-expect-error plain .cjs helper without declarations
import { planStagedArtifacts, isPublishing } from '../../scripts/release/staged-artifacts.cjs'

function keyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}

const keys = keyPair()
const OUT = join('/build', 'dist')

function plan(overrides: {
  updateConfig?: Record<string, unknown>
  builtWindows?: boolean
  publishing?: boolean
  signingKey?: string
  dataFolderName?: string
}) {
  return planStagedArtifacts({
    product: {
      dataFolderName: overrides.dataFolderName,
      updateConfig: {
        provider: 'github',
        owner: 'openkursar',
        repo: 'hello-halo',
        windowsMode: 'staged',
        manifestPublicKey: keys.publicKey,
        ...overrides.updateConfig,
      },
    },
    builtWindows: overrides.builtWindows ?? true,
    publishing: overrides.publishing ?? true,
    signingKey: 'signingKey' in overrides ? overrides.signingKey : keys.privateKey,
    outDir: OUT,
    version: '3.0.0',
  })
}

describe('isPublishing', () => {
  it('follows the --publish flag in every spelling electron-builder accepts', () => {
    expect(isPublishing(['--win'])).toBe(false)
    expect(isPublishing(['--publish', 'never'])).toBe(false)
    expect(isPublishing(['--publish=never'])).toBe(false)
    expect(isPublishing(['--publish', 'always'])).toBe(true)
    expect(isPublishing(['--publish=onTag'])).toBe(true)
    expect(isPublishing(['-p', 'always'])).toBe(true)
    expect(isPublishing(['--publish'])).toBe(false)
  })
})

describe('planStagedArtifacts', () => {
  it('signs a GitHub stable build against the release the archive is uploaded to', () => {
    const result = plan({ dataFolderName: 'halo' })
    expect(result.action).toBe('sign')
    expect(result.args).toEqual([
      '--unpacked', join(OUT, 'win-unpacked'),
      '--out', OUT,
      '--version', '3.0.0',
      '--channel', 'stable',
      '--product-id', 'halo',
      '--github', 'openkursar/hello-halo',
    ])
    // These are the names the client asks for; renaming either breaks every
    // installed copy without an error anywhere.
    expect(result.outputs).toEqual([
      join(OUT, 'halo-3.0.0-win-x64.tar.zst'),
      join(OUT, 'staged-win-x64.json'),
    ])
  })

  it('points a release-server build at that server', () => {
    const result = plan({
      updateConfig: { provider: 'generic', url: 'http://updates.example:18080', channel: 'experience' },
    })
    expect(result.action).toBe('sign')
    expect(result.args).toContain('--base-url')
    expect(result.args).toContain('http://updates.example:18080')
    expect(result.args).toContain('experience')
  })

  it('owes nothing when Windows was not built or staged updates are off', () => {
    expect(plan({ builtWindows: false }).action).toBe('skip')
    expect(plan({ updateConfig: { windowsMode: 'legacy' } }).action).toBe('skip')
    expect(plan({ updateConfig: { manifestPublicKey: ' ' } }).action).toBe('skip')
  })

  it('owes nothing for a GitHub preview build, which clients never read descriptions from', () => {
    expect(plan({ updateConfig: { channel: 'experience' }, signingKey: undefined }).action).toBe('skip')
  })

  it('refuses to publish without the signing key', () => {
    const result = plan({ signingKey: undefined })
    expect(result.action).toBe('fail')
    expect(result.reason).toContain('HALO_UPDATE_SIGNING_KEY')
  })

  it('only warns about a missing key on a build that is not published', () => {
    const result = plan({ signingKey: '', publishing: false })
    expect(result.action).toBe('skip')
    expect(result.warning).toContain('HALO_UPDATE_SIGNING_KEY')
  })

  it('refuses a signing key from a different pair, even for a local build', () => {
    const result = plan({ signingKey: keyPair().privateKey, publishing: false })
    expect(result.action).toBe('fail')
    expect(result.reason).toContain('does not belong')
  })

  it('refuses a signing key that is not an Ed25519 private key', () => {
    const result = plan({ signingKey: 'bm90LWEta2V5' })
    expect(result.action).toBe('fail')
    expect(result.reason).toContain('not a usable Ed25519 private key')
  })

  it('fails a staged build whose feed cannot carry descriptions', () => {
    const result = plan({ updateConfig: { provider: 'github', repo: undefined } })
    expect(result.action).toBe('fail')
  })
})
