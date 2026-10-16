/**
 * Which Macs a Mac update feed offers the update to.
 *
 * An update a Mac cannot run still downloads and installs: electron-updater
 * swaps it in, then macOS refuses to open it, and the working version is gone.
 * The feed's minimumSystemVersion is the only thing that stops that, and the
 * updater compares it with the Darwin version — so these rules are what keep
 * a Mac below the app's floor on the version it can still open.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  darwinVersionForMacOS,
  packagedMinimumMacOS,
  // @ts-expect-error plain .mjs helper without declarations
} from '../../scripts/release/macos-floor.mjs'

const requireCjs = createRequire(import.meta.url)
// The parser electron-updater reads a feed with; it ships no type declarations.
const { load } = requireCjs('js-yaml') as { load: (text: string) => unknown }
const FINALIZE = path.resolve(__dirname, '../../scripts/release/finalize-mac-artifacts.mjs')

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'halo-macos-floor-'))
  scratch.push(dir)
  return dir
}

function writeApp(dist: string, dir: string, { version, minimumMacOS }: { version: string; minimumMacOS?: string }): void {
  const contents = path.join(dist, dir, 'Halo.app', 'Contents')
  fs.mkdirSync(contents, { recursive: true })
  const floor = minimumMacOS ? `<key>LSMinimumSystemVersion</key>\n  <string>${minimumMacOS}</string>\n  ` : ''
  fs.writeFileSync(path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  ` +
    `<key>CFBundleShortVersionString</key>\n  <string>${version}</string>\n  ${floor}</dict>\n</plist>\n`)
}

/** What electron-updater (the copy every shipped Halo runs) decides for a Mac on `darwin`. */
function updaterOffers(darwin: string, minimumSystemVersion: string): boolean {
  const realOs = requireCjs('os') as typeof os
  const { AppUpdater } = requireCjs('electron-updater/out/AppUpdater.js')
  const release = realOs.release
  realOs.release = () => darwin
  try {
    return AppUpdater.prototype.checkIfUpdateSupported.call({ _logger: { info() {}, warn() {} } }, { minimumSystemVersion })
  } finally {
    realOs.release = release
  }
}

describe('Darwin version of a macOS floor', () => {
  it.each([
    ['12.0.0', '21.0.0'],
    ['12.0', '21.0.0'],
    ['11', '20.0.0'],
    ['15.0.0', '24.0.0'],
    ['10.15', '19.0.0'],
    ['10.15.0', '19.0.0'],
    ['26.0', '25.0.0'],
  ])('macOS %s is Darwin %s', (macos, darwin) => {
    expect(darwinVersionForMacOS(macos)).toBe(darwin)
  })

  it.each(['12.3', '10.15.4', '16.0', '25.0', '9.0', 'twelve', ''])('refuses %j instead of guessing', (macos) => {
    expect(() => darwinVersionForMacOS(macos)).toThrow()
  })

  it('keeps a macOS 11 Mac off an update that needs macOS 12, and lets macOS 12 and later through', () => {
    const gate = darwinVersionForMacOS('12.0.0')
    expect(updaterOffers('20.6.0', gate)).toBe(false)
    expect(updaterOffers('21.0.0', gate)).toBe(true)
    expect(updaterOffers('23.5.0', gate)).toBe(true)
    // The macOS number itself would not stop the macOS 11 Mac.
    expect(updaterOffers('20.6.0', '12.0.0')).toBe(true)
  })
})

describe('minimum macOS of the packaged apps', () => {
  it('is what the apps of this version declare, ignoring apps left from other builds', () => {
    const dist = tempDir()
    writeApp(dist, 'mac-arm64', { version: '3.0.0', minimumMacOS: '12.0.0' })
    writeApp(dist, 'mac', { version: '3.0.0', minimumMacOS: '12.0.0' })
    writeApp(dist, 'mac-universal', { version: '2.1.15', minimumMacOS: '10.15' })

    expect(packagedMinimumMacOS(dist, '3.0.0')).toBe('12.0.0')
  })

  it('fails when no app of this version was packaged, or one declares no floor, or they disagree', () => {
    const none = tempDir()
    writeApp(none, 'mac-arm64', { version: '2.1.15', minimumMacOS: '10.15' })
    expect(() => packagedMinimumMacOS(none, '3.0.0')).toThrow(/no packaged mac app of version 3.0.0/)

    const undeclared = tempDir()
    writeApp(undeclared, 'mac-arm64', { version: '3.0.0' })
    expect(() => packagedMinimumMacOS(undeclared, '3.0.0')).toThrow(/declare no LSMinimumSystemVersion/)

    const split = tempDir()
    writeApp(split, 'mac-arm64', { version: '3.0.0', minimumMacOS: '12.0.0' })
    writeApp(split, 'mac', { version: '3.0.0', minimumMacOS: '13.0.0' })
    expect(() => packagedMinimumMacOS(split, '3.0.0')).toThrow(/disagree/)
  })
})

describe('finalize-mac-artifacts', () => {
  const version = '3.0.0'

  function releaseDist(): { dist: string; arm64Yml: string } {
    const dist = tempDir()
    for (const file of [`Halo-${version}-arm64.dmg`, `Halo-${version}-arm64-mac.zip`, `Halo-${version}.dmg`, `Halo-${version}-mac.zip`]) {
      fs.writeFileSync(path.join(dist, file), 'artifact')
    }
    const arm64Yml = path.join(dist, '.latest-mac-arm64.yml')
    fs.writeFileSync(arm64Yml, `version: ${version}\nfiles:\n  - url: Halo-${version}-arm64-mac.zip\n    sha512: arm\n    size: 1\n  - url: Halo-${version}-arm64.dmg\n    sha512: armdmg\n    size: 1\npath: Halo-${version}-arm64-mac.zip\nsha512: arm\nreleaseDate: '2026-10-13T00:00:00.000Z'\n`)
    fs.writeFileSync(path.join(dist, 'latest-mac.yml'), `version: ${version}\nfiles:\n  - url: Halo-${version}-mac.zip\n    sha512: intel\n    size: 1\n  - url: Halo-${version}.dmg\n    sha512: inteldmg\n    size: 1\npath: Halo-${version}-mac.zip\nsha512: intel\nreleaseDate: '2026-10-13T00:00:00.000Z'\n`)
    return { dist, arm64Yml }
  }

  /** Runs the script as a release does; returns null on success, else what it printed. */
  function finalize(dist: string, arm64Yml: string): string | null {
    try {
      execFileSync(process.execPath, [FINALIZE, '--dist', dist, '--version', version, '--arm64-yml', arm64Yml], { stdio: 'pipe' })
      return null
    } catch (err) {
      return String((err as { stdout?: Buffer }).stdout ?? err)
    }
  }

  it('writes the Darwin floor of the packaged apps next to both arches', () => {
    const { dist, arm64Yml } = releaseDist()
    writeApp(dist, 'mac-arm64', { version, minimumMacOS: '12.0.0' })
    writeApp(dist, 'mac', { version, minimumMacOS: '12.0.0' })

    expect(finalize(dist, arm64Yml)).toBeNull()

    const feed = load(fs.readFileSync(path.join(dist, 'latest-mac.yml'), 'utf8')) as { minimumSystemVersion: unknown; files: Array<{ url: string }> }
    expect(feed.minimumSystemVersion).toBe('21.0.0')
    expect(feed.files.map((f) => f.url)).toEqual([
      `Halo-${version}-arm64-mac.zip`, `Halo-${version}-arm64.dmg`, `Halo-${version}-Intel-mac.zip`, `Halo-${version}-Intel.dmg`,
    ])
  })

  it('refuses to write a feed when it cannot tell which macOS the update needs', () => {
    const { dist, arm64Yml } = releaseDist()

    expect(finalize(dist, arm64Yml)).toMatch(/cannot state which Macs may update: no packaged mac app of version 3\.0\.0/)
    expect(load(fs.readFileSync(path.join(dist, 'latest-mac.yml'), 'utf8'))).not.toHaveProperty('minimumSystemVersion')
  })
})
