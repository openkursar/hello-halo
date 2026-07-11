/**
 * Helper library for the decentralized office backend consistency suite.
 *
 * Everything here is HTTP/process-level: no product code is imported. The suite
 * drives the real built nodes launched by scripts/cluster/launch-nodes.mjs and
 * asserts that backend state agrees ACROSS nodes after each action (the core
 * principle in SCENARIOS.md §1.1). See run-scenarios.mjs for the scenarios.
 */

import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(__dirname, '../..')
const LAUNCHER = path.join(PROJECT_ROOT, 'scripts/cluster/launch-nodes.mjs')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Cluster lifecycle (delegates to launch-nodes.mjs) ────────────────────────

export function clusterStop(clusterDir = '.cluster') {
  spawnSync('node', [LAUNCHER, 'stop', '--cluster', clusterDir], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  })
}

/**
 * Pre-seed a PLAINTEXT node identity file so the node's ensureLocalIdentity()
 * takes the load-from-file fast path and never calls Electron safeStorage.
 *
 * Why: on macOS, first-run identity generation encrypts the private key via the
 * OS keychain (safeStorage), which BLOCKS on a keychain prompt that a hidden,
 * GPU-disabled window cannot answer — so a --fresh node hangs forever right
 * after "[FederationStore] Initialized", before the HTTP server ever starts.
 * The product reads decryptString(), which returns a non-ENCRYPTED_PREFIX value
 * as-is, so a plaintext PKCS8 key seeded from Node is loaded verbatim with no
 * keychain access. This mirrors how the launcher pre-seeds config.json.
 */
function seedNodeIdentity(clusterDir, index) {
  const haloDir = path.resolve(PROJECT_ROOT, clusterDir, `node-${index}`, '.halo')
  fs.mkdirSync(haloDir, { recursive: true })
  const file = path.join(haloDir, 'node-identity.json')
  if (fs.existsSync(file)) return // keep a stable identity across restarts
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const digest = crypto.createHash('sha256').update(der).digest('base64url')
  const id = `id_${digest.slice(0, 32)}`
  fs.writeFileSync(
    file,
    JSON.stringify({ id, displayName: `cluster-node-${index}`, publicKey: publicKeyPem, privateKey: privateKeyPem }, null, 2),
  )
}

export function clusterStart({ nodes = 5, basePort = 3460, fresh = true, clusterDir = '.cluster' } = {}) {
  // Manual fresh: wipe ourselves so we can pre-seed identities into node dirs
  // BEFORE the launcher spawns the processes (the launcher's own --fresh would
  // delete our seeded files). We then call the launcher WITHOUT --fresh.
  const dirAbs = path.resolve(PROJECT_ROOT, clusterDir)
  if (fresh && fs.existsSync(dirAbs)) fs.rmSync(dirAbs, { recursive: true, force: true })
  for (let i = 1; i <= nodes; i++) seedNodeIdentity(clusterDir, i)

  const args = [LAUNCHER, 'start', '--nodes', String(nodes), '--base-port', String(basePort), '--cluster', clusterDir]
  const res = spawnSync('node', args, { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 5 * 60_000 })
  // exit code 2 = some node not ready; we still read the manifest and let the
  // runner decide. Non-2 non-0 is a hard launcher failure.
  if (res.status !== 0 && res.status !== 2) {
    throw new Error(`launch-nodes start failed (exit ${res.status})`)
  }
  return loadManifest(clusterDir)
}

export function loadManifest(clusterDir = '.cluster') {
  const file = path.resolve(PROJECT_ROOT, clusterDir, 'nodes.json')
  if (!fs.existsSync(file)) throw new Error(`No manifest at ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * Bearer-authenticated HTTP call to one node. Returns { status, json } so a
 * caller can assert on status codes (e.g. 401/403 scope checks) without throwing.
 * Network failure (node down) returns { status: 0, json: null, error }.
 */
export async function api(node, method, apiPath, body) {
  try {
    const res = await fetch(`${node.baseUrl}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${node.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    let json = null
    try {
      json = await res.json()
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json }
  } catch (err) {
    return { status: 0, json: null, error: err.message }
  }
}

/** api() that throws on transport error or app-level success:false, returns data. */
export async function apiOk(node, method, apiPath, body) {
  const { status, json, error } = await api(node, method, apiPath, body)
  if (status === 0) throw new Error(`node-${node.index} ${method} ${apiPath} transport: ${error}`)
  if (json && json.success === false) {
    throw new Error(`node-${node.index} ${method} ${apiPath} → ${json.error} (status ${status})`)
  }
  return json?.data ?? json
}

/** Poll fn() until it returns truthy, or timeout. Returns the truthy value or null. */
export async function pollUntil(fn, { timeoutMs = 20_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch {
      /* keep polling */
    }
    await sleep(intervalMs)
  }
  return last && false ? last : null
}

// ── Office construction helpers (mirror demo-federation.mjs) ──────────────────

export async function createOffice(node, { spaceName, teamName, goal, proposal }) {
  const space = await apiOk(node, 'POST', '/api/spaces', { name: spaceName, icon: '🏢' })
  const team = await apiOk(node, 'POST', '/api/teams', {
    input: {
      name: teamName,
      goal,
      owningSpaceId: space.id,
      memberSourcing: 'ai',
      collabMode: 'structured',
      escalationRouting: 'lead',
    },
    confirmedProposal: proposal,
  })
  return { spaceId: space.id, team }
}

export async function members(node, teamId) {
  const detail = await apiOk(node, 'GET', `/api/teams/${teamId}/detail`)
  return detail?.members ?? []
}

export async function firstNonLeadAppId(node, teamId) {
  const ms = await members(node, teamId)
  const nonLead = ms.find((m) => !m.isLead) ?? ms[0]
  return nonLead?.appId ?? null
}

export async function mintInvite(node, teamId, body = {}) {
  const { json } = await api(node, 'POST', `/api/teams/${teamId}/invite`, body)
  return json // { success, data:{token,jti,...} } OR { success:false, error }
}

/**
 * Drive a joiner node to provision one local member and join `officeId`.
 * Returns the brought appId. Throws on join failure.
 */
export async function joinOffice(joiner, host, officeId, inviteToken, label) {
  const { team } = await createOffice(joiner, {
    spaceName: `Joiner ${joiner.index} Space ${label ?? ''}`,
    teamName: `Joiner ${joiner.index} Bench ${label ?? ''}`,
    // Non-blocking specialist: replies trivially when contacted, never escalates,
    // so a federation scenario is never stalled by a member asking for clarification.
    goal: 'Connectivity smoke test only. When contacted, reply with ONE short sentence. Never ask anything; no clarification is needed.',
    proposal: [
      { memberName: `Specialist ${joiner.index}`, role: 'specialist', responsibility: 'When you receive any message, reply with a single short sentence. Never ask for clarification, never escalate.' },
    ],
  })
  const bringAppId = await firstNonLeadAppId(joiner, team.id)
  if (!bringAppId) throw new Error(`node-${joiner.index}: no local member to bring`)
  const data = await apiOk(joiner, 'POST', `/api/teams/${officeId}/join`, {
    serverUrl: host.baseUrl,
    inviteToken,
    bringAppIds: [bringAppId],
  })
  return { bringAppId, localTeamId: team.id, data }
}

// ── Cross-node consistency reads + assertions ──────────────────────────────

/** GET /detail from every node for the same teamId. Returns [{node, detail|null, error?}]. */
export async function detailOnAll(nodes, teamId) {
  return Promise.all(
    nodes.map(async (node) => {
      const { status, json, error } = await api(node, 'GET', `/api/teams/${teamId}/detail`)
      return { node, status, detail: json?.data ?? null, error: error ?? (json?.success === false ? json.error : null) }
    }),
  )
}

export async function presenceOnAll(nodes, teamId) {
  return Promise.all(
    nodes.map(async (node) => {
      const { json, error } = await api(node, 'GET', `/api/teams/${teamId}/federation/presence`)
      return { node, presence: json?.data ?? null, error }
    }),
  )
}

/** Stable signature of a node's roster: sorted member appIds + lead + sorted edges. */
function rosterSignature(detail) {
  if (!detail) return null
  const ms = (detail.members ?? []).map((m) => m.appId).sort()
  const lead = detail.team?.leadAppId ?? null
  const edges = (detail.edges ?? [])
    .map((e) => `${e.from ?? e.fromAppId ?? ''}->${e.to ?? e.toAppId ?? ''}`)
    .sort()
  return JSON.stringify({ ms, lead, edges })
}

/**
 * Assert every node's roster agrees on {member set, lead, edges}. `nodes` may be
 * a subset (only those expected to share the office). Returns
 * { ok, evidence, perNode:[{index, members, lead}] }.
 */
export function assertConsistentRoster(details, { expectMembers } = {}) {
  const present = details.filter((d) => d.detail && d.detail.members)
  const perNode = present.map((d) => ({
    index: d.node.index,
    members: (d.detail.members ?? []).map((m) => m.appId).sort(),
    lead: d.detail.team?.leadAppId ?? null,
  }))
  if (present.length === 0) {
    return { ok: false, evidence: 'no node returned a roster', perNode }
  }
  const sigs = present.map((d) => rosterSignature(d.detail))
  const allSame = sigs.every((s) => s === sigs[0])
  let ok = allSame
  let evidence = allSame
    ? `all ${present.length} nodes agree: ${perNode[0].members.length} members, lead=${perNode[0].lead}`
    : `roster mismatch: ${perNode.map((p) => `n${p.index}=[${p.members.join(',')}] lead=${p.lead}`).join(' | ')}`
  if (ok && expectMembers != null && perNode[0].members.length !== expectMembers) {
    ok = false
    evidence = `expected ${expectMembers} members, got ${perNode[0].members.length} (${perNode[0].members.join(',')})`
  }
  return { ok, evidence, perNode }
}

/**
 * Assert board (tasks/findings) agreement across nodes: same task-id set, no
 * duplicate task ids within any node, committedWriteAuthority ≤ 1 (single
 * authority — derived from presence authority.isSelf count).
 */
export function assertConsistentBoard(details, presences) {
  const present = details.filter((d) => d.detail)
  if (present.length === 0) return { ok: false, evidence: 'no board data' }
  const taskSets = present.map((d) => ({
    index: d.node.index,
    ids: (d.detail.tasks ?? []).map((t) => t.id),
  }))
  for (const ts of taskSets) {
    const dupes = ts.ids.filter((id, i) => ts.ids.indexOf(id) !== i)
    if (dupes.length) return { ok: false, evidence: `node-${ts.index} duplicate task ids: ${[...new Set(dupes)].join(',')}` }
  }
  const sorted = taskSets.map((ts) => [...new Set(ts.ids)].sort())
  const allSame = sorted.every((s) => JSON.stringify(s) === JSON.stringify(sorted[0]))
  let authCount = null
  if (presences) {
    authCount = presences.filter((p) => p.presence?.authority?.isSelf).length
  }
  const evidence =
    `task-id sets ${allSame ? 'agree' : 'DIFFER'} (${sorted.map((s, i) => `n${taskSets[i].index}:${s.length}`).join(',')})` +
    (authCount != null ? `; authoritySelf=${authCount}` : '')
  const ok = allSame && (authCount == null || authCount <= 1)
  return { ok, evidence }
}

/** GET /chat-messages for one member from every node; returns per-node transcripts. */
export async function chatOnAll(nodes, teamId, appId, epochId) {
  const results = await Promise.all(
    nodes.map(async (node) => {
      const q = epochId ? `?appId=${appId}&epochId=${epochId}` : `?appId=${appId}`
      const { status, json, error } = await api(node, 'GET', `/api/teams/${teamId}/chat-messages${q}`)
      return { node, status, messages: json?.data ?? null, error: error ?? (json?.success === false ? json.error : null) }
    }),
  )
  return results
}

// ── Fault injection (process level) ──────────────────────────────────────────

export function killNode(node) {
  try {
    process.kill(node.pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

/**
 * Revive a previously-killed node by re-spawning the built app with the SAME
 * isolated HOME/HALO_DATA_DIR, so it restores its identity + auto-rejoins. The
 * launcher's seedNodeConfig already wrote config.json under nodeDir/.halo, and
 * --fresh is NOT used so on-disk state (identity, join-conn) survives.
 * Returns the new pid (the node object's pid is updated in place).
 */
export async function reviveNode(node, clusterDir = '.cluster') {
  const appEntry = path.join(PROJECT_ROOT, 'out/main/index.mjs')
  const nodeDir = path.resolve(PROJECT_ROOT, clusterDir, `node-${node.index}`)
  const out = fs.openSync(node.logFile ?? path.join(nodeDir, 'node.log'), 'a')
  const electronBinary = (await import('electron')).default
  const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = process.env
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
  node.pid = child.pid
  const ok = await pollUntil(
    async () => {
      const r = await api(node, 'GET', '/api/teams')
      return r.status === 200
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  )
  return ok ? node.pid : null
}

// ── Reporting harness ─────────────────────────────────────────────────────────

export class Reporter {
  constructor() {
    this.records = []
  }
  add(id, status, evidence, extra = {}) {
    this.records.push({ id, status, evidence, ...extra })
    const icon = { PASS: '✅', FAIL: '❌', PARTIAL: '⚠️', SKIP: '⏭️' }[status] ?? '?'
    console.log(`${icon} ${id}: ${status} — ${evidence}`)
  }
  pass(id, ev, x) { this.add(id, 'PASS', ev, x) }
  fail(id, ev, x) { this.add(id, 'FAIL', ev, x) }
  partial(id, ev, x) { this.add(id, 'PARTIAL', ev, x) }
  skip(id, ev, x) { this.add(id, 'SKIP', ev, x) }

  /** Wrap a scenario body so a throw becomes a FAIL instead of aborting the run. */
  async run(id, fn) {
    try {
      await fn((status, ev, x) => this.add(id, status, ev, x))
    } catch (err) {
      this.add(id, 'FAIL', `threw: ${err.message}`)
    }
  }

  tally() {
    const t = { PASS: 0, FAIL: 0, PARTIAL: 0, SKIP: 0 }
    for (const r of this.records) t[r.status] = (t[r.status] ?? 0) + 1
    return { total: this.records.length, ...t }
  }
}
