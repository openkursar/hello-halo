import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getGitSha } from './git-sha'

const __filename = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(__filename), '../../..')

interface BuildIdentityFile {
  sha: string
  dirty: boolean
  recordedAt: string
}

const sidecarCandidates = [
  'out/main/.build-identity.json',
  'dist/mac-arm64/.build-identity.json',
  'dist/mac/.build-identity.json',
  'dist/win-unpacked/.build-identity.json',
  'dist/linux-unpacked/.build-identity.json'
]

/**
 * Identity of the binary actually under test — not the sha of whatever the
 * working tree happens to be when the test runs. Sourced from the sidecar
 * `tests/perf/record-build.mjs` writes right after a build; without it we
 * fall back to the live HEAD and say so, since that fallback can silently
 * lie once the tree changes after the build.
 */
export function getBuildIdentityString(): string {
  for (const rel of sidecarCandidates) {
    const file = path.join(projectRoot, rel)
    if (!fs.existsSync(file)) continue
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as BuildIdentityFile
      return `${data.sha}${data.dirty ? '-dirty' : ''}`
    } catch {
      // Malformed sidecar — fall through to the worktree fallback below.
    }
  }
  return `${getGitSha()} (unverified: run tests/perf/record-build.mjs after building)`
}
