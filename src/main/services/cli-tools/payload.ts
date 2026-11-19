/**
 * Payload inspection: the integrity digest and the "pure JavaScript" rule.
 *
 * The integrity digest is the sha256 of a canonical listing of every payload
 * file — `<relative path>\0<sha256 hex>\n`, sorted by path — written in
 * subresource-integrity form (`sha256-<base64>`), so it identifies
 * content independently of archive compression or entry order. Packaging tools
 * compute the same value with `computePayloadIntegrity`.
 *
 * Only pure-JS tools run on the bundled runtime. A payload is rejected when it
 * contains a compiled addon (`.node`), a `binding.gyp`, an executable image
 * (ELF / Mach-O / PE), a package that declares install scripts or `gypfile`, or a
 * package pinned to an OS/CPU or depending on per-platform optional packages.
 * These are heuristics over what is packaged; they do not run any code.
 */

import { createHash } from 'crypto'
import { promises as fsp } from 'fs'
import { join, posix } from 'path'
import { CliToolError } from './errors'

export interface PayloadFile {
  /** Path relative to the payload root, `/`-separated. */
  path: string
  sha256: string
  size: number
}

export interface PayloadInspection {
  integrity: string
  files: number
  bytes: number
}

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall']
const PLATFORM_PACKAGE = /(?:^|[-/@])(darwin|linux|win32|windows|android|freebsd|sunos|aix)(?:[-_]|$)/i

function isExecutableImage(path: string, head: Buffer): boolean {
  if (head.length >= 4) {
    const magic = head.readUInt32BE(0)
    // ELF, Mach-O 32/64 (both byte orders) and universal binaries.
    if (magic === 0x7f454c46) return true
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) {
      // 0xcafebabe is also a Java class file; those are not runnable here either.
      return true
    }
  }
  // PE images start with "MZ"; only trusted for Windows executable extensions to
  // avoid flagging text that happens to begin with those two letters.
  return /\.(exe|dll)$/i.test(path) && head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a
}

function checkPackageJson(path: string, text: string): void {
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(text) as Record<string, unknown>
  } catch {
    // A malformed package.json cannot declare scripts that would ever run here.
    return
  }
  if (!pkg || typeof pkg !== 'object') return
  const scripts = pkg.scripts as Record<string, unknown> | undefined
  if (scripts && typeof scripts === 'object') {
    const found = INSTALL_SCRIPTS.filter(name => typeof scripts[name] === 'string')
    if (found.length > 0) {
      throw new CliToolError('NATIVE_NOT_ALLOWED', `${path} declares install scripts (${found.join(', ')})`)
    }
  }
  if (pkg.gypfile === true) {
    throw new CliToolError('NATIVE_NOT_ALLOWED', `${path} declares a native build (gypfile)`)
  }
  if (Array.isArray(pkg.os) || Array.isArray(pkg.cpu)) {
    throw new CliToolError('NATIVE_NOT_ALLOWED', `${path} is a platform-specific package (os/cpu)`)
  }
  const optional = pkg.optionalDependencies
  if (optional && typeof optional === 'object') {
    const platformDeps = Object.keys(optional).filter(name => PLATFORM_PACKAGE.test(name))
    if (platformDeps.length > 0) {
      throw new CliToolError(
        'NATIVE_NOT_ALLOWED',
        `${path} depends on per-platform packages (${platformDeps.slice(0, 3).join(', ')})`
      )
    }
  }
}

/**
 * Walk `payloadDir` (no symlinks allowed), hash every file and apply the
 * pure-JS rule. Returns the files sorted by path.
 */
export async function scanPayload(payloadDir: string, enforcePureJs = true): Promise<PayloadFile[]> {
  const files: PayloadFile[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const childRel = rel ? posix.join(rel, entry.name) : entry.name
      const childAbs = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw new CliToolError('PATH_UNSAFE', `payload contains a symlink: ${childRel}`)
      }
      if (entry.isDirectory()) {
        await walk(childAbs, childRel)
        continue
      }
      if (!entry.isFile()) {
        throw new CliToolError('PATH_UNSAFE', `payload contains a special file: ${childRel}`)
      }
      const data = await fsp.readFile(childAbs)
      if (enforcePureJs) {
        if (/\.node$/i.test(entry.name) || entry.name === 'binding.gyp') {
          throw new CliToolError('NATIVE_NOT_ALLOWED', `payload contains native code: ${childRel}`)
        }
        if (isExecutableImage(entry.name, data.subarray(0, 4))) {
          throw new CliToolError('NATIVE_NOT_ALLOWED', `payload contains an executable image: ${childRel}`)
        }
        if (entry.name === 'package.json') checkPackageJson(childRel, data.toString('utf-8'))
      }
      files.push({ path: childRel, sha256: createHash('sha256').update(data).digest('hex'), size: data.byteLength })
    }
  }
  await walk(payloadDir, '')
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return files
}

/** The canonical integrity string of an already scanned file list. */
export function integrityOf(files: PayloadFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${file.path}\0${file.sha256}\n`)
  return `sha256-${hash.digest('base64')}`
}

/** First hex characters of an integrity digest, used to name store directories. */
export function integrityShortHex(integrity: string, length = 12): string {
  return Buffer.from(integrity.slice('sha256-'.length), 'base64').toString('hex').slice(0, length)
}

/**
 * Integrity of a payload directory, for packaging tools. Does not apply the
 * pure-JS rule; importing does.
 */
export async function computePayloadIntegrity(payloadDir: string): Promise<string> {
  return integrityOf(await scanPayload(payloadDir, false))
}

/** Scan, enforce the pure-JS rule and summarize. */
export async function inspectPayload(payloadDir: string): Promise<PayloadInspection> {
  const files = await scanPayload(payloadDir, true)
  return {
    integrity: integrityOf(files),
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  }
}
