/**
 * The delivery bundle (`halo.cli.bundle/1`): one zip carrying a tool's
 * unchanged `.hcli` package and the skill that goes with it, so both arrive,
 * are checked and are switched together. Catalog delivery and the build's
 * presets use only this form.
 *
 *   bundle.json   strict description: id, version, revision, CLI digests, skill digest
 *   bundle.sig    optional Ed25519 signature over bundle.json (see signature.ts)
 *   cli.hcli      the approved `halo.cli/1` package, byte for byte
 *   skill/        SKILL.md and its files; absent when the tool has no skill
 *
 * `readBundle` runs the checks in the agreed order and stops at the first
 * failure: whole-bundle digest and size, entry layout and limits (read from the
 * zip directory before anything is inflated), signature and strict
 * bundle.json, the CLI package digest, then the skill digest and file count.
 * It returns the CLI package bytes for the ordinary `.hcli` import and the
 * skill files in memory; nothing is written to disk here.
 */

import { createHash } from 'crypto'
import type { UnzipFileInfo } from 'fflate'
import { z } from 'zod'
import { CliToolError } from './errors'
import { isSafeRelativePath } from './manifest'
import { assertBundleSignature, parseBundleSignature, type TrustStore } from './signature'

export const BUNDLE_SCHEMA = 'halo.cli.bundle/1'
export const SKILL_DIGEST_DOMAIN = 'halo.cli.skillpkg/1'
export const BUNDLE_MAX_BYTES = 129 * 1024 * 1024
/** Largest SKILL.md a bundle may carry. */
export const BUNDLE_SKILL_MAIN_MAX_BYTES = 1024 * 1024
const CLI_MAX_BYTES = 128 * 1024 * 1024
const SKILL_MAX_BYTES = 32 * 1024 * 1024
const SKILL_MAX_FILES = 2000
const METADATA_MAX_BYTES = 64 * 1024

const SHA256_HEX = /^[0-9a-f]{64}$/

/** What the catalog (or the build's preset catalog) says one bundle is. */
export interface BundleReference {
  id: string
  version: string
  revision: number
  /** Lowercase hex sha256 of the whole zip. */
  sha256: string
  size: number
}

export type BundleSkillSource = 'store' | 'text' | 'package-guide'

export interface BundleSkill {
  /** `halo.cli.skillpkg/1` digest of the files. */
  sha256: string
  source: BundleSkillSource
  /** Paths relative to `skill/`, always including `SKILL.md`. */
  files: Map<string, Buffer>
}

export interface VerifiedBundle {
  id: string
  version: string
  revision: number
  sha256: string
  cli: { archiveSha256: string; integrity: string; size: number }
  /** The `.hcli` package exactly as approved. */
  hcli: Uint8Array
  skill: BundleSkill | null
}

const bundleJsonSchema = z.object({
  schema: z.literal(BUNDLE_SCHEMA),
  id: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cli: z.object({
    archiveSha256: z.string().regex(SHA256_HEX),
    integrity: z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/),
    size: z.number().int().positive().max(CLI_MAX_BYTES),
  }).strict(),
  skill: z.object({
    sha256: z.string().regex(SHA256_HEX),
    files: z.number().int().positive().max(SKILL_MAX_FILES),
    source: z.enum(['store', 'text', 'package-guide']),
    sourceRef: z.string().max(512).optional(),
  }).strict().nullable(),
}).strict()

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * `halo.cli.skillpkg/1`: sha256 over the domain line, then each file (paths
 * relative to `skill/`, sorted by their UTF-8 bytes) as "<path>\n<sha256>\n".
 */
export function skillPackageSha256(files: ReadonlyMap<string, Uint8Array>): string {
  const paths = [...files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8')))
  const hash = createHash('sha256').update(`${SKILL_DIGEST_DOMAIN}\n`, 'utf-8')
  for (const path of paths) hash.update(`${path}\n${sha256(files.get(path)!)}\n`, 'utf-8')
  return hash.digest('hex')
}

function invalid(message: string): CliToolError {
  return new CliToolError('PACKAGE_INVALID', message)
}

/** Check one zip directory entry against the bundle layout before it is inflated. */
function admitEntry(file: UnzipFileInfo, seen: Set<string>, totals: { skillFiles: number; skillBytes: number }): void {
  const directory = file.name.endsWith('/')
  const path = directory ? file.name.slice(0, -1) : file.name
  if (!isSafeRelativePath(path)) {
    throw new CliToolError('PATH_UNSAFE', `bundle entry "${file.name.slice(0, 200)}" is not a safe relative path`)
  }
  const folded = path.toLowerCase()
  if (seen.has(folded)) throw new CliToolError('PATH_UNSAFE', `bundle entry "${file.name.slice(0, 200)}" collides with another entry`)
  seen.add(folded)
  if (path === 'skill' || path.startsWith('skill/')) {
    if (directory) return
    if (path === 'skill') throw invalid('bundle entry "skill" must be a directory')
    totals.skillFiles += 1
    totals.skillBytes += file.originalSize
    if (totals.skillFiles > SKILL_MAX_FILES) throw invalid(`bundle skill has more than ${SKILL_MAX_FILES} files`)
    if (totals.skillBytes > SKILL_MAX_BYTES) throw invalid('bundle skill exceeds its size limit')
    return
  }
  if (directory) throw invalid(`bundle entry "${file.name.slice(0, 200)}" is outside the bundle layout`)
  if (path === 'cli.hcli') {
    if (file.originalSize > CLI_MAX_BYTES) throw invalid('bundled CLI package exceeds its size limit')
    return
  }
  if (path === 'bundle.json' || path === 'bundle.sig') {
    if (file.originalSize > METADATA_MAX_BYTES) throw invalid(`${path} exceeds its size limit`)
    return
  }
  throw invalid(`bundle entry "${file.name.slice(0, 200)}" is outside the bundle layout`)
}

function parseJson(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw invalid(`${name} is not valid UTF-8 JSON`)
  }
}

/**
 * Verify a downloaded or bundled delivery bundle against what the catalog
 * says it is. Throws a typed error at the first failed check; on success the
 * caller hands `hcli` to the ordinary package import.
 */
export async function readBundle(bytes: Uint8Array, expected: BundleReference, trust: TrustStore): Promise<VerifiedBundle> {
  const label = `${expected.id}@${expected.version} r${expected.revision}`
  if (bytes.byteLength > BUNDLE_MAX_BYTES) throw invalid(`${label} bundle exceeds its size limit`)
  const digest = sha256(bytes)
  if (bytes.byteLength !== expected.size || digest !== expected.sha256) {
    throw new CliToolError('DIGEST_MISMATCH', `${label} bundle differs from the catalog digest or size`)
  }

  // Loaded on first use: sessions read this module long before any bundle arrives.
  const { unzipSync } = await import('fflate')
  const seen = new Set<string>()
  const totals = { skillFiles: 0, skillBytes: 0 }
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes, { filter: file => (admitEntry(file, seen, totals), true) })
  } catch (err) {
    if (err instanceof CliToolError) throw err
    throw invalid(`${label} bundle is not a readable zip file`)
  }

  const bundleJson = entries['bundle.json']
  if (!bundleJson) throw invalid(`${label} bundle has no bundle.json`)
  const rawSig = entries['bundle.sig']
  const signature = rawSig ? parseBundleSignature(parseJson(rawSig, 'bundle.sig')) : null
  if (rawSig && !signature && trust.mode !== 'off') throw new CliToolError('SIGNATURE_INVALID', `${label} bundle.sig is malformed`)
  assertBundleSignature(trust, bundleJson, signature, label)

  const parsed = bundleJsonSchema.safeParse(parseJson(bundleJson, 'bundle.json'))
  if (!parsed.success) throw invalid(`${label} bundle.json does not satisfy ${BUNDLE_SCHEMA}`)
  const info = parsed.data
  if (info.id !== expected.id || info.version !== expected.version || info.revision !== expected.revision) {
    throw invalid(`bundle declares ${info.id}@${info.version} r${info.revision}, expected ${label}`)
  }

  const hcli = entries['cli.hcli']
  if (!hcli) throw invalid(`${label} bundle has no cli.hcli`)
  if (hcli.byteLength !== info.cli.size || sha256(hcli) !== info.cli.archiveSha256) {
    throw new CliToolError('DIGEST_MISMATCH', `${label} CLI package differs from bundle.json`)
  }

  const files = new Map<string, Buffer>()
  for (const [name, data] of Object.entries(entries)) {
    if (name.startsWith('skill/') && !name.endsWith('/')) {
      files.set(name.slice('skill/'.length), Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    }
  }
  let skill: BundleSkill | null = null
  if (info.skill === null) {
    if (files.size > 0) throw invalid(`${label} bundle carries skill files but declares no skill`)
  } else {
    const main = files.get('SKILL.md')
    if (!main) throw invalid(`${label} bundle skill has no SKILL.md`)
    if (main.byteLength > BUNDLE_SKILL_MAIN_MAX_BYTES) throw invalid(`${label} SKILL.md exceeds its size limit`)
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(main)
    } catch {
      throw invalid(`${label} SKILL.md is not UTF-8 text`)
    }
    if (files.size !== info.skill.files || skillPackageSha256(files) !== info.skill.sha256) {
      throw new CliToolError('DIGEST_MISMATCH', `${label} skill files differ from bundle.json`)
    }
    skill = { sha256: info.skill.sha256, source: info.skill.source, files }
  }

  return {
    id: info.id,
    version: info.version,
    revision: info.revision,
    sha256: digest,
    cli: info.cli,
    hcli,
    skill,
  }
}
