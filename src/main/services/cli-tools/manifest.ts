/**
 * The `halo.cli/1` package manifest: the only metadata a tool author supplies.
 *
 * The schema is strict — an unknown key is rejected rather than ignored, so a
 * typo never silently changes behavior; additions bump the schema id. Where a
 * tool came from (preset, catalog, user import) is recorded by the host from
 * the import path, never trusted from the package.
 */

import { z } from 'zod'
import { CliToolError } from './errors'

export const CLI_MANIFEST_SCHEMA = 'halo.cli/1'

/** Reverse-DNS style id, e.g. `com.example.deploy`. */
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
/** Strict semver 2.0 (no leading `v`). */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
/** A bare command name; never a path. The `halo-` prefix is reserved for conflict aliases. */
const COMMAND_PATTERN = /^(?!halo-)[a-z0-9][a-z0-9._-]{0,63}$/
const PLATFORM_PATTERN = /^(any|(darwin|win32|linux)-(arm64|x64))$/
const NODE_VERSION_PATTERN = /^\d+(?:\.\d+){0,2}$/
/** Subresource-integrity form, as npm and the external runtime manager use. */
const INTEGRITY_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/

/**
 * A package-relative path written with `/`. Rejects absolute paths, drive
 * letters, backslashes, empty and dot segments — the archive extractor applies
 * the same rule to entries, so a manifest path can only name a packaged file.
 */
export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false
  if (/^[a-zA-Z]:/.test(value)) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

const relativePath = z.string().refine(isSafeRelativePath, 'must be a safe relative path')

const CommandSchema = z.object({
  name: z.string().regex(COMMAND_PATTERN, 'must be a bare lowercase command name not starting with halo-'),
  /**
   * JS entry relative to `payload/`: a `.js`, `.mjs` or `.cjs` file, or an
   * extensionless script as npm `bin` entries often are (Node runs it as JS).
   */
  entry: relativePath.refine(
    p => /\.(c|m)?js$/.test(p) || !p.split('/').pop()!.includes('.'),
    'must be a .js, .mjs, .cjs or extensionless file'
  ),
}).strict()

export const CliManifestSchema = z.object({
  schema: z.literal(CLI_MANIFEST_SCHEMA),
  id: z.string().max(128).regex(ID_PATTERN, 'must be a lowercase reverse-DNS id'),
  version: z.string().max(64).regex(SEMVER_PATTERN, 'must be semver'),
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(1024).optional(),
  commands: z.array(CommandSchema).min(1).max(32),
  runtime: z.object({
    /** Reserved enum: only `halo-node` is accepted in this version. */
    kind: z.enum(['halo-node', 'binary']),
    minNode: z.string().regex(NODE_VERSION_PATTERN).optional(),
  }).strict(),
  platforms: z.array(z.string().regex(PLATFORM_PATTERN)).min(1).max(16),
  /** Digest of the payload file list, see `computePayloadIntegrity`. */
  integrity: z.string().regex(INTEGRITY_PATTERN),
  /** Declares how the tool authenticates; never carries a credential. */
  auth: z.object({
    method: z.enum(['none', 'env-ref', 'external-login']),
  }).strict().optional(),
  nonInteractive: z.boolean().optional(),
  outputFormats: z.array(z.string().max(32)).max(8).optional(),
  sideEffects: z.enum(['read-only', 'writes']).optional(),
  /** Usage guide for the AI, relative to the package root, under `guide/`. */
  guide: relativePath.refine(p => p.startsWith('guide/'), 'must be under guide/').optional(),
}).strict().superRefine((manifest, ctx) => {
  const seen = new Set<string>()
  for (const command of manifest.commands) {
    if (seen.has(command.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate command "${command.name}"` })
    }
    seen.add(command.name)
  }
})

export type CliManifest = z.infer<typeof CliManifestSchema>

/** Parse manifest text; every failure is `MANIFEST_INVALID` with the first issues listed. */
export function parseCliManifest(text: string): CliManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new CliToolError('MANIFEST_INVALID', 'manifest.json is not valid JSON')
  }
  const result = CliManifestSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new CliToolError('MANIFEST_INVALID', `manifest.json is invalid: ${issues}`)
  }
  return result.data
}

/** Compare dotted numeric versions; missing parts count as 0. */
export function compareNodeVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Host compatibility of a parsed manifest: runtime kind, runtime version and
 * platform. Throws the matching typed error; returns nothing on success.
 */
export function assertManifestSupported(
  manifest: CliManifest,
  host: { platform: string; arch: string; nodeVersion: string }
): void {
  if (manifest.runtime.kind !== 'halo-node') {
    throw new CliToolError(
      'RUNTIME_KIND_UNSUPPORTED',
      `runtime kind "${manifest.runtime.kind}" is not supported; only halo-node packages are accepted`
    )
  }
  if (manifest.runtime.minNode && compareNodeVersions(host.nodeVersion, manifest.runtime.minNode) < 0) {
    throw new CliToolError(
      'RUNTIME_VERSION_UNSUPPORTED',
      `package needs Node ${manifest.runtime.minNode}; bundled runtime is ${host.nodeVersion}`
    )
  }
  const target = `${host.platform}-${host.arch}`
  if (!manifest.platforms.includes('any') && !manifest.platforms.includes(target)) {
    throw new CliToolError('PLATFORM_UNSUPPORTED', `package does not support ${target}`)
  }
}
