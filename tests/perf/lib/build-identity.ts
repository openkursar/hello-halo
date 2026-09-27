import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getGitSha } from './git-sha'
import type { ArtifactKind, BuildIdentity } from '../types'

const __filename = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(__filename), '../../..')

/**
 * Build output directory -> what kind of artifact it holds. `out/main` (the
 * electron-vite build the perf fixture launches) and a packaged `.app` can
 * carry the same commit while differing in asar packing and signing, so a
 * result is only comparable to another with the same kind.
 */
export const ARTIFACT_DIRS: Array<{ dir: string; kind: ArtifactKind }> = [
  { dir: 'out/main', kind: 'electron-vite' },
  { dir: 'dist/mac-arm64', kind: 'packaged-mac-arm64' },
  { dir: 'dist/mac', kind: 'packaged-mac-x64' },
  { dir: 'dist/win-unpacked', kind: 'packaged-win' },
  { dir: 'dist/linux-unpacked', kind: 'packaged-linux' }
]

export const SIDECAR_NAME = '.build-identity.json'

/**
 * Directory holding the artifact the harness actually launches.
 * `getAppEntryPath()` resolves the package.json `main` entry under `out/main`,
 * so that is the default;
 * `PERF_ARTIFACT_DIR` is for a run pointed at a packaged build instead.
 *
 * This is deliberately a single directory rather than "whichever sidecar
 * exists": with a stale `dist/` sidecar left over from an earlier package,
 * a search would label an `out/main` measurement `packaged-mac-arm64` and
 * read as verified.
 */
function artifactDir(): { dir: string; kind: ArtifactKind | null } {
  const override = process.env.PERF_ARTIFACT_DIR
  if (!override) return ARTIFACT_DIRS[0]
  return ARTIFACT_DIRS.find((a) => a.dir === override) ?? { dir: override, kind: null }
}

/**
 * Identity of the binary actually under test, from the sidecar
 * `tests/perf/record-build.mjs` writes right after a build.
 *
 * With no sidecar we fall back to the live HEAD and mark the result
 * `verified: false` as a boolean a gate can act on — appending
 * "(unverified: ...)" to the sha string instead, as an earlier version did,
 * put the warning somewhere nothing machine-readable would ever look.
 * Set `PERF_REQUIRE_VERIFIED_BUILD=1` to make that fallback throw instead.
 */
export function getBuildIdentity(): BuildIdentity {
  const { dir, kind } = artifactDir()
  const file = path.join(projectRoot, dir, SIDECAR_NAME)
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { sha: string; dirty: boolean; artifactKind?: ArtifactKind }
      return { sha: data.sha, dirty: data.dirty, artifactKind: data.artifactKind ?? kind, verified: true }
    } catch {
      // Malformed sidecar — fall through to the worktree fallback below.
    }
  }

  if (process.env.PERF_REQUIRE_VERIFIED_BUILD === '1') {
    throw new Error(
      `No readable ${SIDECAR_NAME} in ${dir} — cannot prove which build is under test. Run: npm run build && node tests/perf/record-build.mjs`
    )
  }

  return { sha: getGitSha(), dirty: false, artifactKind: null, verified: false }
}
