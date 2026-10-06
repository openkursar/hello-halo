#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recordBuild, snapshotContent, createBuildRecord, gitContext } from './build-identity/index.mjs'

const projectRoot = process.argv.find(argument => argument.startsWith('--project-root='))?.slice('--project-root='.length) || resolve(fileURLToPath(new URL('../..', import.meta.url)))
const artifactDir = process.argv.find(argument => argument.startsWith('--artifact-dir='))?.slice('--artifact-dir='.length) || 'out/main'
try {
  const dryRun = process.argv.includes('--dry-run')
  const record = dryRun ? createBuildRecord(await snapshotContent(projectRoot, { artifactDir }), gitContext(projectRoot)) : await recordBuild(projectRoot, { artifactDir })
  console.log(`[record-build] ${artifactDir}: source=${record.content.source.count} artifacts=${record.content.artifacts.count} harness=${record.content.harness.count} fixtures=${record.content.fixtures.count}`)
  console.log(`[record-build] ${record.sha}${record.dirty ? ' (dirty)' : ''}; frozen content, source compilation provenance is not attested`)
  if (dryRun) console.log('[record-build] Dry run verified; no build sidecar was written')
} catch (error) {
  console.error(`[record-build] Content identity was not recorded: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
