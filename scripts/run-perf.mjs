#!/usr/bin/env node
/**
 * run-perf — the entry point for a performance measurement run.
 *
 * `tests/playwright.config.ts` loads `.env.local` for every project, so
 * whatever `HALO_TEST_*` sits in that file becomes the AI source for S2/S6/S8.
 * If it names a real provider, those scenarios measure a stream whose token
 * count and timing differ every run, and the numbers cannot be compared to
 * anything. This starts the deterministic local SSE mock and points the run at
 * it first; `dotenv` does not override variables that are already set, which is
 * what makes overriding from out here sufficient.
 *
 *   node scripts/run-perf.mjs --project=perf [...playwright args]
 *
 * `PERF_REAL_API=1` keeps `.env.local` instead — right when the question is
 * about a real provider, wrong for a before/after comparison. Either way the
 * run records which source it used in every result's `aiSource`.
 */

import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const playwrightArgs = process.argv.slice(2)

if (!playwrightArgs.some((a) => a.startsWith('--project'))) {
  console.error('run-perf: pass --project=<perf|perf-release|perf-soak>')
  process.exit(2)
}

/** Asks the OS for a free port rather than assuming the mock's default is free — a mock left running by an aborted run would otherwise silently serve the next one. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePort(port))
    })
  })
}

function waitForListening(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolveWait, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); resolveWait() })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) reject(new Error(`mock did not start listening on 127.0.0.1:${port} within ${timeoutMs}ms`))
        else setTimeout(attempt, 100)
      })
    }
    attempt()
  })
}

let mock = null
let mockDiedEarly = false
let stoppingMock = false
const env = { ...process.env }

const stopMock = () => { stoppingMock = true; mock?.kill('SIGTERM'); mock = null }
// Without this, killing this process leaves the mock listening, and the next
// run's freePort() would hand out a different port while the stale one lingers.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopMock(); process.exit(130) })
}

if (process.env.PERF_REAL_API === '1') {
  console.log('run-perf: PERF_REAL_API=1 — using the AI source from .env.local; streaming scenarios are not reproducible this run\n')
} else {
  const port = await freePort()
  // Bounded: the mock logs a line per request, and a soak runs for 45 minutes.
  // Only ever read to explain a startup failure.
  const mockLog = []
  const note = (d) => { if (mockLog.length < 200) mockLog.push(d.toString()) }

  mock = spawn(process.execPath, ['tests/perf/mock/sse-server.mjs'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, MOCK_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  mock.stdout.on('data', note)
  mock.stderr.on('data', note)
  mock.on('error', (err) => { mockLog.push(`spawn failed: ${err.message}\n`) })
  // A result stamped aiSource:'mock' is only trustworthy if the mock was
  // actually answering. If it dies mid-run, every scenario after that point
  // measured something else while still claiming to be deterministic.
  mock.on('exit', () => { if (!stoppingMock) mockDiedEarly = true })

  try {
    await waitForListening(port)
  } catch (err) {
    stopMock()
    console.error(`run-perf: ${err.message}`)
    if (mockLog.length) console.error(mockLog.join(''))
    process.exit(2)
  }

  // The four variables tests/e2e/fixtures/electron.ts reads, and which it
  // requires to be set together. normalizeApiUrl() appends
  // /v1/chat/completions to a bare host, so no path is needed here.
  env.HALO_TEST_PROVIDER = 'openai'
  env.HALO_TEST_API_URL = `http://127.0.0.1:${port}`
  env.HALO_TEST_API_KEY = 'mock-key'
  env.HALO_TEST_MODEL = 'mock-sse-v1'
  // Only this process can claim the mock is genuinely the one answering; a key
  // pointing at localhost proves nothing on its own.
  env.PERF_AI_SOURCE = 'mock'
  console.log(`run-perf: deterministic SSE mock on 127.0.0.1:${port}\n`)
}

const run = spawnSync('npx', ['playwright', 'test', '--config', 'tests/playwright.config.ts', ...playwrightArgs], {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
})

stopMock()

if (run.error) {
  console.error(`run-perf: cannot run playwright: ${run.error.message}`)
  process.exit(2)
}
if (mockDiedEarly) {
  console.error('\nrun-perf: the SSE mock exited before the run finished — results written after that point claim aiSource:"mock" with nothing answering. Treat this run as unmeasured.')
  process.exit(2)
}
process.exit(run.status ?? 1)
