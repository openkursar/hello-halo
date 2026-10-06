#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beginRun, finishRun } from './index.mjs'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const args = process.argv.slice(2)
const label = process.env.PERF_LABEL
if (!label || !/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('PERF_LABEL must identify one new frozen candidate run')
const resultDir = resolve(root, 'tests/perf/results', label)
let run
let child
let signal
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => { signal = name; child?.kill(name) })
try {
  run = await beginRun(root, resultDir, { artifactDir: process.env.PERF_ARTIFACT_DIR || 'out/main' })
  console.log(`[PerfIdentity] Preflight verified ${run.run.runId}; dirty remains ${run.run.pre.git.dirty}`)
  child = spawn(process.execPath, ['scripts/run-perf.mjs', ...args], { cwd: root, env: { ...process.env, PERF_CONTENT_IDENTITY_RUN: run.file }, stdio: 'inherit' })
  const exit = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolveExit({ code, signal })) })
  await finishRun(run.file)
  console.log(`[PerfIdentity] Postflight verified; witness: ${run.file}`)
  process.exitCode = exit.code === 0 && !exit.signal && !signal ? 0 : 1
} catch (error) {
  console.error(`[PerfIdentity] Frozen candidate run was not authenticated: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
