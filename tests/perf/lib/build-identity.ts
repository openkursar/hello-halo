import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'node:child_process'
import { getGitSha } from './git-sha'
import { ARTIFACT_LAYOUTS, SIDECAR_NAME, readReportReference } from '../build-identity/index.mjs'
import type { ContentIdentityReference } from '../build-identity/index.mjs'
import type { ArtifactKind, BuildIdentity } from '../types'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const ARTIFACT_DIRS = ARTIFACT_LAYOUTS as Array<{ dir: string; kind: ArtifactKind }>
export { SIDECAR_NAME }
export interface ContentBuildIdentity extends BuildIdentity { contentIdentity?: ContentIdentityReference }
let warned = false

function artifactDir(): { dir: string; kind: ArtifactKind | null } {
  const override = process.env.PERF_ARTIFACT_DIR
  if (!override) return ARTIFACT_DIRS[0]
  return ARTIFACT_DIRS.find(artifact => artifact.dir === override) ?? { dir: override, kind: null }
}

function currentDirty(): boolean {
  return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '-z'], { cwd: projectRoot, encoding: 'utf8' }).length > 0
}

/** The run controller verifies full bytes outside sampling; results retain a small immutable reference. */
export function getBuildIdentity(): ContentBuildIdentity {
  const { dir, kind } = artifactDir()
  const runFile = process.env.PERF_CONTENT_IDENTITY_RUN
  if (runFile) {
    const reference = readReportReference(runFile)
    return { sha: reference.sha, dirty: reference.dirty, artifactKind: reference.artifactKind as ArtifactKind, verified: true, contentIdentity: reference.identity }
  }
  const file = path.join(projectRoot, dir, SIDECAR_NAME)
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { sha: string; dirty: boolean; artifactKind?: ArtifactKind }
      if (typeof data.sha !== 'string' || typeof data.dirty !== 'boolean') throw new Error('Build sidecar lacks Git identity fields')
      return { sha: data.sha, dirty: data.dirty, artifactKind: data.artifactKind ?? kind, verified: true }
    } catch (error) {
      if (!warned) { console.warn(`[PerfIdentity] Build sidecar was not usable: ${file}: ${error instanceof Error ? error.message : String(error)}`); warned = true }
    }
  }
  if (process.env.PERF_REQUIRE_VERIFIED_BUILD === '1') throw new Error(`No readable ${SIDECAR_NAME} in ${dir}; production artifact identity is unknown`)
  return { sha: getGitSha(), dirty: currentDirty(), artifactKind: null, verified: false }
}
