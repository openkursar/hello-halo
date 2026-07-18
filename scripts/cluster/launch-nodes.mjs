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
 *                                         [--template NAME]
 *   node scripts/cluster/launch-nodes.mjs stop [--cluster DIR]
 *
 * Templates (--template NAME). When set, after all nodes are ready the launcher
 * provisions a single federated office so the cluster is usable out-of-the-box:
 * node-1 HOSTS the office (its system Lead is the coordinator and also fields one
 * contestant), and every other node JOINS bringing one member. Members = nodes
 * (host's own + one per joiner). Omit --template to keep nodes empty. Names:
 *   joke - 笑话大赛:  Lead=评委;   members=选手 (each tells an original joke)
 *   rps  - 猜拳大战:  Lead=裁判;   members=猜拳选手 (rock/paper/scissors, one round)
 *   book - 书评团:    Lead=主编;   members=不同职业书评人 (rate an assigned book)
 *   rnd  - 研发团队:  Lead=技术负责人; members=产品/后端/前端/测试工程师
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

// ── Federated office templates ───────────────────────────────────────────────

/**
 * Each template defines the hosted office (name + goal that steers the auto-
 * provisioned Lead) and a `member(index)` factory that yields one contestant per
 * node. index is 1-based: 1 = the host's own on-court member, 2..N = each joiner.
 * memberName carries the index so homogeneous templates never collide on the
 * host's unique (team, member_name) index.
 */
const TEMPLATES = {
  joke: {
    teamName: '笑话大赛',
    goal:
      '你是本次"笑话大赛"的评委。团队里的每位选手会各讲一个原创笑话。请逐一给每个笑话' +
      '打分（1-10）并写简短点评，最后排出名次、宣布冠军。',
    member: (i) => ({
      memberName: `选手${i}`,
      role: '参赛选手',
      responsibility: '构思并讲一个简短的原创笑话，然后交给评委打分。',
    }),
  },
  rps: {
    teamName: '猜拳大战',
    goal:
      '你是本次猜拳对决的裁判。每位选手会在石头、剪刀、布中各出一个。请收集所有出拳，' +
      '按"石头胜剪刀、剪刀胜布、布胜石头"的规则裁决这一轮胜负，并宣布赢家。',
    member: (i) => ({
      memberName: `选手${i}`,
      role: '猜拳选手',
      responsibility: '在石头、剪刀、布中选择一个出拳，并说明你出的是什么。',
    }),
  },
  book: {
    teamName: '书评团',
    goal:
      '你是书评团的主编。请指定一本书（例如《三体》），让每位书评人从各自的职业视角阅读' +
      '并给这本书打分（1-10）、写一段点评，最后由你汇总各视角的评分与观点给出综合结论。',
    member: (i) => {
      const professions = ['教师', '程序员', '编剧', '心理咨询师', '历史学家']
      const p = professions[(i - 1) % professions.length]
      return {
        memberName: `${p}·书评人${i}`,
        role: `书评人·${p}`,
        responsibility: `以${p}的职业视角评价主编指定的书，给出打分（1-10）和一段点评。`,
      }
    },
  },
  rnd: {
    teamName: '研发团队',
    goal:
      '你是研发团队的技术负责人。带领团队完成一个小功能（例如一个命令行待办事项工具）。' +
      '请把目标拆成可独立执行的子任务，分配给各位工程师，验收他们交付的产出并整合成最终结果。',
    member: (i) => {
      const roles = [
        { role: '产品经理', responsibility: '梳理需求，写出清晰的功能说明和验收标准。' },
        { role: '后端工程师', responsibility: '实现核心逻辑并写入文件，交付文件路径。' },
        { role: '前端工程师', responsibility: '实现交互/界面部分并交付文件。' },
        { role: '测试工程师', responsibility: '针对交付物编写并执行测试，报告结果。' },
      ]
      const r = roles[(i - 1) % roles.length]
      return { memberName: `${r.role}${i}`, role: r.role, responsibility: r.responsibility }
    },
  },
}

/** Authenticated JSON call to a node's remote-access API; throws on failure. */
async function nodeApi(node, method, apiPath, body) {
  const res = await fetch(`${node.baseUrl}${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${node.token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json = {}
  try {
    json = await res.json()
  } catch {
    /* empty/non-JSON body */
  }
  if (!res.ok || json.success === false) {
    throw new Error(`${method} ${apiPath} on node-${node.index} failed: ${res.status} ${json.error || ''}`.trim())
  }
  return json.data
}

/** First existing space on a node, or a freshly created one. */
async function resolveSpaceId(node) {
  const spaces = await nodeApi(node, 'GET', '/api/spaces')
  if (Array.isArray(spaces) && spaces.length > 0) return spaces[0].id
  const created = await nodeApi(node, 'POST', '/api/spaces', { name: 'Cluster', icon: '🧪' })
  return created.id
}

/** An automation app spec for one contestant/member digital human. */
function memberSpec(member, teamName) {
  return {
    spec_version: '1',
    name: member.memberName,
    version: '1.0',
    author: 'Halo',
    description: member.responsibility,
    type: 'automation',
    icon: '🤝',
    system_prompt:
      `You are "${member.memberName}", role: ${member.role}, a member of the digital team ` +
      `"${teamName}". ${member.responsibility} Do the hands-on work in your own space, write ` +
      `large outputs to files and share their paths, and report back when a task is done or ` +
      `when you are blocked.`,
    store: { install_source: 'manual' },
  }
}

/**
 * Provision one federated office across the ready nodes: node-1 hosts (Lead auto-
 * provisioned + one on-court member), each remaining node joins bringing a member.
 * Returns a manifest fragment describing the office for the external driver.
 */
async function provisionTemplate(nodes, key) {
  const tpl = TEMPLATES[key]
  if (!tpl) {
    throw new Error(`Unknown template "${key}". Options: ${Object.keys(TEMPLATES).join(', ')}`)
  }
  const ready = nodes.filter((n) => n.ready)
  if (ready.length < 2) {
    throw new Error(`Template needs >=2 ready nodes (host + >=1 joiner); ready=${ready.length}`)
  }

  const host = ready[0]
  const joiners = ready.slice(1)
  LOG(`Provisioning template "${key}" (${tpl.teamName}): host=node-${host.index}, joiners=${joiners.length}`)

  // Host office (system Lead auto-provisioned; structured topology).
  const hostSpaceId = await resolveSpaceId(host)
  const team = await nodeApi(host, 'POST', '/api/teams', {
    input: {
      name: tpl.teamName,
      goal: tpl.goal,
      owningSpaceId: hostSpaceId,
      memberSourcing: 'manual',
      collabMode: 'structured',
      escalationRouting: 'user',
      members: [],
    },
  })
  const officeId = team.id
  LOG(`  office=${officeId} created on node-${host.index} (Lead auto-provisioned)`)

  const members = []

  // Host also fields a contestant (member #1): install locally, add to the team.
  const hostMember = tpl.member(1)
  const hostApp = await nodeApi(host, 'POST', '/api/apps/install', {
    spaceId: hostSpaceId,
    spec: memberSpec(hostMember, tpl.teamName),
  })
  await nodeApi(host, 'POST', `/api/teams/${officeId}/members`, {
    appId: hostApp.appId,
    memberName: hostMember.memberName,
    role: hostMember.role,
  })
  members.push({ node: host.index, host: true, appId: hostApp.appId, ...hostMember })
  LOG(`  node-${host.index} on-court member: ${hostMember.memberName} (${hostMember.role})`)

  // Invite once; each joiner reuses the same office credential.
  const invite = await nodeApi(host, 'POST', `/api/teams/${officeId}/invite`, {})
  const inviteToken = invite.token
  const hostServerUrl = `http://127.0.0.1:${host.port}`

  for (let j = 0; j < joiners.length; j++) {
    const node = joiners[j]
    const member = tpl.member(j + 2)
    const spaceId = await resolveSpaceId(node)
    const app = await nodeApi(node, 'POST', '/api/apps/install', {
      spaceId,
      spec: memberSpec(member, tpl.teamName),
    })
    await nodeApi(node, 'POST', `/api/teams/${officeId}/join`, {
      serverUrl: hostServerUrl,
      inviteToken,
      bringAppIds: [app.appId],
    })
    members.push({ node: node.index, host: false, appId: app.appId, ...member })
    LOG(`  node-${node.index} joined as ${member.memberName} (${member.role})`)
  }

  return { template: key, teamName: tpl.teamName, officeId, hostNode: host.index, inviteToken, members }
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

  // Optionally build a ready-to-use federated office across the ready nodes.
  // Best-effort: a provisioning failure is warned but never aborts the cluster.
  let template = null
  if (args.template) {
    try {
      template = await provisionTemplate(nodes, String(args.template))
      LOG(`Template "${template.template}" ready: office=${template.officeId} members=${template.members.length}`)
    } catch (err) {
      WARN(`Template provisioning failed: ${err.message}`)
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    clusterDir: dir,
    model: { baseUrl: model.baseUrl, modelId: model.modelId, provider: model.provider, hasKey: !!model.apiKey },
    nodes,
    template,
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
