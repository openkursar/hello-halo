/**
 * Which changed files count as generated, so the view can hide them and show
 * them folded: lockfiles, minified bundles, source maps and test snapshots,
 * plus whatever `.gitattributes` marks `linguist-generated` (reported by git).
 * Projects add their own through `.gitattributes`, the shared, standard place.
 */

import { matchesGlob } from './file-filter'
import { baseName } from './paths'

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'cargo.lock',
  'gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'go.sum',
  'mix.lock',
  'pubspec.lock',
  'podfile.lock',
  'flake.lock',
  'packages.lock.json',
  'gradle.lockfile',
  'package.resolved',
])

const OUTPUT_PATTERNS = ['*.min.js', '*.min.mjs', '*.min.cjs', '*.min.css', '*.map', '*.snap', '**/__snapshots__/**']

export interface GeneratedFileInput {
  path: string
  /** Set by git from `.gitattributes`. */
  generated?: boolean
}

export function isGeneratedFile(file: GeneratedFileInput): boolean {
  if (file.generated) return true
  if (LOCKFILES.has(baseName(file.path).toLowerCase())) return true
  return OUTPUT_PATTERNS.some((pattern) => matchesGlob(file.path, pattern))
}
