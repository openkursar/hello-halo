#!/usr/bin/env node
/**
 * generate-icons.mjs — rebuild the packaging icons under resources/
 *
 * `package.json#build` names three icon artifacts for macOS / Windows / Linux.
 * When one is missing, electron-builder does not fail: it logs a warning and
 * packages the default Electron icon, which is only visible by inspecting the
 * built app. This script regenerates them from the two committed sources:
 *
 *   resources/icon-macos-1024.png -> resources/icon.icns    (macOS)
 *   resources/icon-1024.png       -> resources/icon.ico     (Windows, 16..256)
 *                                 -> resources/linux/*.png  (Linux, 16..512)
 *
 * The macOS source is a separate file so it can carry the platform's safe-area
 * padding. The current artwork fills the canvas on every platform, so the two
 * sources are identical for now.
 *
 * The .icns is produced by app-builder, the same converter electron-builder
 * validates icons with, so the artifact cannot drift from what the packager
 * accepts. The .ico is assembled here because app-builder writes a single
 * 256px entry, while Windows picks the rung it needs from the full ladder.
 * PNG rungs are scaled with macOS `sips`.
 *
 * The last step re-resolves all three artifacts exactly as electron-builder
 * does and fails if any of them would fall back to the Electron default.
 *
 * Usage: node scripts/generate-icons.mjs
 * Exit codes:
 *   0 — artifacts written and re-verified
 *   1 — a source is missing, a tool failed, or an artifact would fall back
 */

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const RESOURCES_DIR = join(PROJECT_ROOT, 'resources')

const MACOS_SOURCE = join(RESOURCES_DIR, 'icon-macos-1024.png')
const GENERIC_SOURCE = join(RESOURCES_DIR, 'icon-1024.png')
const ICNS_OUT = join(RESOURCES_DIR, 'icon.icns')
const ICO_OUT = join(RESOURCES_DIR, 'icon.ico')
const LINUX_DIR = join(RESOURCES_DIR, 'linux')

/** Windows selects from these; Windows Explorer asks for 16/32/48/256. */
const WINDOWS_SIZES = [16, 24, 32, 48, 64, 128, 256]
/** Linux desktop environments index icons by size directory. */
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

const log = {
  info: (m) => console.log(`[generate-icons] ${m}`),
  err: (m) => console.error(`[generate-icons] ERROR ${m}`),
}

/** app-builder is the icon converter electron-builder itself shells out to. */
function appBuilder(args) {
  const binary = require('app-builder-bin').appBuilderPath
  const stdout = execFileSync(binary, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout)
}

/** Scale one source PNG to `size`x`size`; sips only writes square output via -z. */
function resize(source, size, output) {
  execFileSync('sips', ['-z', String(size), String(size), source, '--out', output], { stdio: 'ignore' })
}

/**
 * Assemble a multi-size ICO. Each entry holds a complete PNG (the format
 * Windows has accepted for entries of any size since Vista); the directory
 * records the rung so Explorer can pick 16px for a list and 256px for a
 * preview. `0` encodes 256, which does not fit in the one-byte field.
 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = header.length + directory.length
  const payloads = []
  entries.forEach(({ size, data }, index) => {
    const at = index * 16
    const dimension = size >= 256 ? 0 : size
    directory.writeUInt8(dimension, at)
    directory.writeUInt8(dimension, at + 1)
    directory.writeUInt8(0, at + 2)
    directory.writeUInt8(0, at + 3)
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += data.length
    payloads.push(data)
  })

  return Buffer.concat([header, directory, ...payloads])
}

function scaleLadder(source, sizes, outputDir) {
  return sizes.map((size) => {
    const output = join(outputDir, `${size}.png`)
    resize(source, size, output)
    return { size, path: output, data: readFileSync(output) }
  })
}

/**
 * Mirror of PlatformPackager.resolveIcon: same roots, same inputs. Anything
 * other than isFallback:false means the packager would ship Electron's icon.
 */
function verifyElectronBuilderWouldAccept({ format, inputs, label }) {
  const out = mkdtempSync(join(tmpdir(), 'halo-icon-verify-'))
  try {
    const result = appBuilder([
      'icon',
      '--format', format,
      '--root', RESOURCES_DIR,
      '--root', PROJECT_ROOT,
      '--out', out,
      ...inputs.flatMap((input) => ['--input', input]),
    ])
    if (result.error) throw new Error(result.error)
    if (result.isFallback) throw new Error('resolved to the default Electron icon')
    if (!result.icons || result.icons.length === 0) throw new Error('no icon produced')
    log.info(`${label}: ${result.icons.length} icon file(s), no fallback`)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

function main() {
  if (process.platform !== 'darwin') {
    log.err('sips (macOS) is required to scale the PNG ladder')
    process.exit(1)
  }
  for (const source of [MACOS_SOURCE, GENERIC_SOURCE]) {
    if (!existsSync(source)) {
      log.err(`missing source image ${source}`)
      process.exit(1)
    }
  }

  const staging = mkdtempSync(join(tmpdir(), 'halo-icons-'))
  try {
    const generic = scaleLadder(GENERIC_SOURCE, LINUX_SIZES, staging)
    const bySize = new Map(generic.map((entry) => [entry.size, entry.data]))

    const icnsStaging = join(staging, 'icns')
    mkdirSync(icnsStaging)
    const icns = appBuilder([
      'icon',
      '--format', 'icns',
      '--root', RESOURCES_DIR,
      '--out', icnsStaging,
      '--input', 'icon-macos-1024.png',
    ])
    if (icns.isFallback || !icns.icons?.[0]) throw new Error('app-builder refused the macOS source image')
    copyFileSync(icns.icons[0].file, ICNS_OUT)
    log.info(`icon.icns <- icon-macos-1024.png`)

    mkdirSync(LINUX_DIR, { recursive: true })
    for (const size of LINUX_SIZES) {
      copyFileSync(join(staging, `${size}.png`), join(LINUX_DIR, `${size}x${size}.png`))
    }
    log.info(`resources/linux <- icon-1024.png (${LINUX_SIZES.length} sizes)`)

    writeFileSync(ICO_OUT, buildIco(WINDOWS_SIZES.map((size) => ({ size, data: bySize.get(size) }))))
    log.info(`icon.ico <- icon-1024.png (${WINDOWS_SIZES.join(', ')})`)

    verifyElectronBuilderWouldAccept({ format: 'icns', inputs: ['icon.icns'], label: 'macOS' })
    verifyElectronBuilderWouldAccept({ format: 'ico', inputs: ['icon.ico'], label: 'Windows' })
    verifyElectronBuilderWouldAccept({ format: 'set', inputs: ['linux'], label: 'Linux' })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

main()
