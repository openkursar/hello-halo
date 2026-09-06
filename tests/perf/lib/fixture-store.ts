import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const fixturesRoot = path.resolve(path.dirname(__filename), '../fixtures')
const generatedRoot = path.join(fixturesRoot, 'generated')
const manifestPath = path.join(fixturesRoot, 'manifest.json')

const REGENERATE = 'python3 tests/perf/fixtures/generate.py'

interface ManifestEntry {
  bytes: number
  sha256: string
}

let manifest: Record<string, ManifestEntry> | null = null
const verified = new Set<string>()

function loadManifest(): Record<string, ManifestEntry> {
  if (manifest) return manifest
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Fixture manifest missing: ${manifestPath}. Without it no fixture can be trusted; restore it from git.`)
  }
  manifest = (JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { fixtures: Record<string, ManifestEntry> }).fixtures
  return manifest
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Absolute path to a generated fixture, verified byte-for-byte against
 * `manifest.json` first.
 *
 * The fixtures are large and generated, so they are not tracked; the manifest
 * is. Every failure below throws: a scenario that runs against a missing or
 * altered fixture produces a number that looks ordinary and means nothing,
 * which is strictly worse than not running at all.
 */
export function fixturePath(name: string): string {
  const file = path.join(generatedRoot, name)
  if (verified.has(name)) return file

  const expected = loadManifest()[name]
  if (!expected) {
    throw new Error(`Fixture "${name}" is not in ${manifestPath}. Add it to generate.py's FIXTURES and regenerate the manifest.`)
  }
  if (!fs.existsSync(file)) {
    throw new Error(`Fixture "${name}" not generated. Run: ${REGENERATE}`)
  }

  const bytes = fs.statSync(file).size
  if (bytes !== expected.bytes) {
    throw new Error(`Fixture "${name}" is ${bytes} bytes, manifest says ${expected.bytes}. Regenerate: ${REGENERATE}`)
  }
  const actual = sha256(file)
  if (actual !== expected.sha256) {
    throw new Error(`Fixture "${name}" sha256 ${actual} != manifest ${expected.sha256}. Regenerate: ${REGENERATE}`)
  }

  verified.add(name)
  return file
}

/** Every fixture name the manifest declares, for whole-set verification. */
export function manifestFixtureNames(): string[] {
  return Object.keys(loadManifest()).sort()
}
