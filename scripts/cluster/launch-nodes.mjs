#!/usr/bin/env node
/**
 * Local multi-node federation cluster launcher.
 *
 * Spins up N fully isolated Halo instances on one machine so a distributed
 * digital office can be exercised end-to-end (join / run / presence) without N
 * physical computers. Each node is a real, independent federation node:
 *   - isolated HOME + HALO_DATA_DIR  → distinct on-disk state and node identity
 *   - HALO_E2E_TEST=1                → bypasses the single-instance lock
 *   - remote access pre-enabled on a unique port with a known PIN
 *   - an OpenAI-compatible model source seeded from env (no secret in source)
 *
 * The launcher pre-seeds each node's config.json, spawns it detached, waits for
 * its HTTP API to come up, reads its federation identity id, and writes a
 * machine-readable `<cluster>/nodes.json` describing every node so an external
 * driver (human or AI) can operate each node purely over HTTP.
 *
 * Usage:
 *   node scripts/cluster/launch-nodes.mjs [start] [--nodes N] [--base-port P]
 *                                         [--cluster DIR] [--build] [--fresh]
 *   node scripts/cluster/launch-nodes.mjs stop [--cluster DIR]
 *
 * Model credentials (required for agents to actually run). Auto-loaded from
 * `.env.local` at the project root (gitignored), or the process env. The shared
 * E2E names are used so one config serves both E2E and the cluster; the
 * cluster-specific *_MODEL_* names override them when present:
 *   HALO_TEST_API_KEY  / HALO_TEST_MODEL_API_KEY   - API key
 *   HALO_TEST_API_URL  / HALO_TEST_MODEL_BASE_URL  - base URL (OpenAI-compatible)
 *   HALO_TEST_MODEL    / HALO_TEST_MODEL_ID        - model id
 *   HALO_TEST_PROVIDER / HALO_TEST_MODEL_PROVIDER  - source provider id
 */

import { spawn, spawnSync } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')

const LOG = (...args) => console.log('[cluster]', ...args)
const WARN = (...args) => console.warn('[cluster]', ...args)
const FAIL = (msg) => {
  console.error('[cluster] ERROR:', msg)
  process.exit(1)
}

// ── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        args[key] = true
      } else {
        args[key] = next
        i++
      }
    } else {
      args._.push(a)
    }
  }
  return args
}

// ── .env.local loader ────────────────────────────────────────────────────────

/**
 * Load KEY=VALUE pairs from the project-root `.env.local` into process.env
 * WITHOUT overriding values already present (an explicit shell env wins). Mirrors
 * the minimal parser in electron.vite.config.ts. Quotes are stripped; `#` lines
 * and blanks are skipped. Single-quoted JSON values (e.g. OAuth blobs) survive.
 */
function loadEnvLocal() {
  const envPath = path.join(PROJECT_ROOT, '.env.local')
  if (!fs.existsSync(envPath)) return
  const content = fs.readFileSync(envPath, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

// ── Model source (from .env.local / env, never hardcoded) ────────────────────

function resolveModelSource() {
  const apiKey = process.env.HALO_TEST_MODEL_API_KEY || process.env.HALO_TEST_API_KEY || ''
  const baseUrl =
    process.env.HALO_TEST_MODEL_BASE_URL ||
    process.env.HALO_TEST_API_URL ||
    'https://open.bigmodel.cn/api/coding/paas/v4'
  const modelId = process.env.HALO_TEST_MODEL_ID || process.env.HALO_TEST_MODEL || 'glm-5.2'
  const provider = process.env.HALO_TEST_MODEL_PROVIDER || process.env.HALO_TEST_PROVIDER || 'custom'
  if (!apiKey) {
    WARN(
      'No model API key found (HALO_TEST_API_KEY / HALO_TEST_MODEL_API_KEY).\n' +
      '          Set it in .env.local — nodes will start but agents cannot run without it.'
    )
  }
  return { apiKey, baseUrl, modelId, provider }
}

// ── Paths & build ────────────────────────────────────────────────────────────

function getAppEntryPath() {
  const appEntry = path.join(PROJECT_ROOT, 'out/main/index.mjs')
  if (!fs.existsSync(appEntry)) {
    FAIL('Built app not found at out/main/index.mjs. Run "npm run build" first, or pass --build.')
  }
  return appEntry
}

function runBuild() {
  LOG('Building app (npm run build)…')
  const result = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit' })
  if (result.status !== 0) FAIL('npm run build failed.')
}

/**
 * Copy product.json into out/main/ with provider paths rewritten relative to
 * that directory. Unpackaged, app.getAppPath() resolves to out/main/, so the
 * auth-loader looks for product.json there. Mirrors the E2E fixture.
 */
function ensureProductJson() {
  const srcProductJson = path.join(PROJECT_ROOT, 'product.json')
  const destDir = path.join(PROJECT_ROOT, 'out/main')
  const destProductJson = path.join(destDir, 'product.json')
  if (!fs.existsSync(srcProductJson)) return
  try {
    const product = JSON.parse(fs.readFileSync(srcProductJson, 'utf-8'))
    if (Array.isArray(product.authProviders)) {
      for (const provider of product.authProviders) {
        if (provider.path && provider.path.startsWith('./')) {
          const absolutePath = path.resolve(PROJECT_ROOT, provider.path)
          provider.path = path.relative(destDir, absolutePath)
        }
      }
    }
    fs.writeFileSync(destProductJson, JSON.stringify(product, null, 2))
  } catch (err) {
    WARN('Failed to prepare out/main/product.json:', err.message)
  }
}

// ── Per-node config seeding ──────────────────────────────────────────────────

/**
 * A policy-compliant PIN (>=8 chars, upper+lower+digit+special) the driver uses
 * directly as the bearer token. Stored only in the gitignored cluster dir.
 */
function nodePin(index) {
  return `HaloNode-${index}-Aa1!`
}

function seedNodeConfig(nodeDir, index, port, model) {
  const haloDir = path.join(nodeDir, '.halo')
  fs.mkdirSync(path.join(haloDir, 'temp', 'artifacts'), { recursive: true })
  fs.mkdirSync(path.join(haloDir, 'temp', 'conversations'), { recursive: true })
  fs.mkdirSync(path.join(haloDir, 'spaces'), { recursive: true })

  const sources = []
  if (model.apiKey) {
    sources.push({
      id: crypto.randomUUID(),
      name: 'Cluster Test Model',
      provider: model.provider,
      authType: 'api-key',
      apiUrl: model.baseUrl,
      apiType: 'chat_completions',
      apiKey: model.apiKey,
      model: model.modelId,
      availableModels: [{ id: model.modelId, name: model.modelId }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  const config = {
    api: {
      provider: 'anthropic',
      apiKey: '',
      apiUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
    },
    aiSources: {
      version: 2,
      currentId: sources.length > 0 ? sources[0].id : null,
      sources,
    },
    permissions: {
      fileAccess: 'allow',
      commandExecution: 'allow',
      networkAccess: 'allow',
      trustMode: true,
    },
    appearance: { theme: 'dark' },
    system: { autoLaunch: false },
    // Agent Teams must be on for multi-agent + federation collaboration.
    agent: { maxTurns: 999, promptProfile: 'halo', enableTeams: true },
    // Remote access pre-enabled: the extended-init idle task auto-restores the
    // HTTP server on this port using the plaintext PIN below as the token.
    remoteAccess: { enabled: true, port, password: nodePin(index) },
    onboarding: { completed: true },
    mcpServers: {},
    isFirstLaunch: false,
  }

  fs.writeFileSync(path.join(haloDir, 'config.json'), JSON.stringify(config, null, 2))
}

/**
 * macOS: the Claude Agent SDK resolves a headless Electron to spawn model
 * subprocesses. Pre-create the expected symlink under this node's isolated
 * userData so agent runs don't accumulate Dock icons. Mirrors the E2E fixture.
 */
function ensureSdkSymlink(nodeDir, appEntry) {
  if (process.platform !== 'darwin') return
  const headlessDir = path.join(nodeDir, 'Library', 'Application Support', 'Halo', 'headless-electron')
  fs.mkdirSync(headlessDir, { recursive: true })
  const symlinkPath = path.join(headlessDir, 'electron-node')
  try {
    if (!fs.existsSync(symlinkPath)) fs.symlinkSync(appEntry, symlinkPath)
  } catch (err) {
    WARN('Failed to create SDK symlink:', err.message)
  }
}

// ── Spawn & readiness ────────────────────────────────────────────────────────

function spawnNode(appEntry, nodeDir, logFile) {
  const electronBinary = require('electron')
  // Strip ELECTRON_RUN_AS_NODE so Electron boots as a full app, not plain Node.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = process.env
  const out = fs.openSync(logFile, 'a')
  const child = spawn(electronBinary, [appEntry], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...cleanEnv,
      HOME: nodeDir,
      USERPROFILE: nodeDir,
      HALO_DATA_DIR: path.join(nodeDir, '.halo'),
      HALO_E2E_TEST: '1',
      ELECTRON_DISABLE_GPU: '1',
    },
  })
  child.unref()
  return child.pid
}

async function waitForApi(port, pin, timeoutMs = 60000) {
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/remote/status`)
      if (res.ok) {
        // Confirm the token is live too (auth restored from config).
        const auth = await fetch(`${base}/api/teams`, { headers: { Authorization: `Bearer ${pin}` } })
        if (auth.status === 200) return true
      }
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  return false
}

function readIdentityId(nodeDir, timeoutMs = 15000) {
  const idFile = path.join(nodeDir, '.halo', 'node-identity.json')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(idFile)) {
        const raw = JSON.parse(fs.readFileSync(idFile, 'utf-8'))
        if (raw?.id) return raw.id
      }
    } catch {
      /* mid-write */
    }
    spawnSync('sleep', ['0.3'])
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Cluster state ────────────────────────────────────────────────────────────

function clusterDir(args) {
  return path.resolve(PROJECT_ROOT, args.cluster || '.cluster')
}

function nodesFilePath(dir) {
  return path.join(dir, 'nodes.json')
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdStart(args) {
  const count = Number(args.nodes || 3)
  const basePort = Number(args['base-port'] || 3460)
  const dir = clusterDir(args)
  const model = resolveModelSource()

  if (args.build) runBuild()
  const appEntry = getAppEntryPath()
  ensureProductJson()

  if (args.fresh && fs.existsSync(dir)) {
    LOG(`Removing existing cluster dir ${dir}`)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  fs.mkdirSync(dir, { recursive: true })

  LOG(`Starting ${count} node(s), base port ${basePort}, cluster dir ${dir}`)

  const nodes = []
  for (let i = 1; i <= count; i++) {
    const port = basePort + i
    const nodeDir = path.join(dir, `node-${i}`)
    fs.mkdirSync(nodeDir, { recursive: true })
    seedNodeConfig(nodeDir, i, port, model)
    ensureSdkSymlink(nodeDir, appEntry)

    const logFile = path.join(nodeDir, 'node.log')
    const pid = spawnNode(appEntry, nodeDir, logFile)
    LOG(`node-${i}: pid=${pid} port=${port} (waiting for API…)`)

    const pin = nodePin(i)
    const ready = await waitForApi(port, pin)
    if (!ready) {
      WARN(`node-${i} API did not become ready in time; see ${logFile}`)
    }
    const identityId = ready ? readIdentityId(nodeDir) : null

    nodes.push({
      index: i,
      pid,
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
      token: pin,
      identityId,
      dataDir: path.join(nodeDir, '.halo'),
      logFile,
      ready,
    })
    LOG(`node-${i}: ready=${ready} identity=${identityId ?? 'unknown'}`)
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    clusterDir: dir,
    model: { baseUrl: model.baseUrl, modelId: model.modelId, provider: model.provider, hasKey: !!model.apiKey },
    nodes,
  }
  fs.writeFileSync(nodesFilePath(dir), JSON.stringify(manifest, null, 2))

  LOG(`Wrote ${nodesFilePath(dir)}`)
  // Emit the manifest as the last stdout block so a driver can parse it.
  console.log(JSON.stringify(manifest, null, 2))

  const failed = nodes.filter((n) => !n.ready)
  if (failed.length > 0) {
    WARN(`${failed.length} node(s) not ready. Inspect their node.log.`)
    process.exit(2)
  }
  LOG('All nodes ready. Drive them over HTTP; run "stop" to terminate.')
}

function cmdStop(args) {
  const dir = clusterDir(args)
  const file = nodesFilePath(dir)
  if (!fs.existsSync(file)) FAIL(`No cluster manifest at ${file}`)
  const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'))
  for (const node of manifest.nodes || []) {
    if (!node.pid) continue
    try {
      process.kill(node.pid, 'SIGTERM')
      LOG(`Stopped node-${node.index} (pid ${node.pid})`)
    } catch (err) {
      WARN(`node-${node.index} (pid ${node.pid}) not running: ${err.message}`)
    }
  }
  LOG('Cluster stopped. Node data dirs are preserved; delete the cluster dir to reset.')
}

// ── Entry ────────────────────────────────────────────────────────────────────

async function main() {
  loadEnvLocal()
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] || 'start'
  if (cmd === 'start') {
    await cmdStart(args)
  } else if (cmd === 'stop') {
    cmdStop(args)
  } else {
    FAIL(`Unknown command "${cmd}". Use "start" or "stop".`)
  }
}

main().catch((err) => FAIL(err.stack || err.message))
