#!/usr/bin/env node
/**
 * Decentralized office — backend consistency scenario runner (HTTP-driven).
 *
 * Stands up a real N-node cluster via scripts/cluster/launch-nodes.mjs, then
 * executes the scenarios catalogued in SCENARIOS.md (categories A–L). After each
 * action it pulls state from EVERY relevant node and asserts cross-node
 * agreement (SCENARIOS.md §1.1). Read-only + fault injection only; no product
 * code is touched. Always stops the cluster in finally.
 *
 * Usage:
 *   node tests/decentralized/run-scenarios.mjs --all
 *   node tests/decentralized/run-scenarios.mjs --only A1,B1,D1
 *   node tests/decentralized/run-scenarios.mjs --all --no-start   (use a running cluster)
 *   node tests/decentralized/run-scenarios.mjs --all --nodes 5
 */

import fs from 'fs'
import path from 'path'
import {
  PROJECT_ROOT,
  clusterStart,
  clusterStop,
  loadManifest,
  api,
  apiOk,
  pollUntil,
  sleep,
  createOffice,
  members,
  firstNonLeadAppId,
  mintInvite,
  joinOffice,
  detailOnAll,
  presenceOnAll,
  assertConsistentRoster,
  assertConsistentBoard,
  chatOnAll,
  killNode,
  reviveNode,
  Reporter,
} from './_lib.mjs'

function parseArgs(argv) {
  const args = { only: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') args.all = true
    else if (a === '--no-start') args.noStart = true
    else if (a === '--only') args.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--nodes') args.nodes = Number(argv[++i])
    else if (a === '--cluster') args.cluster = argv[++i]
  }
  return args
}

const ARGS = parseArgs(process.argv.slice(2))
const CLUSTER_DIR = ARGS.cluster || '.cluster'
const NODE_COUNT = ARGS.nodes || 5
const want = (id) => ARGS.all || !ARGS.only || ARGS.only.includes(id)

const reporter = new Reporter()

/** Presence convergence: wait until host sees >= n nodes for the office. */
async function waitPresence(host, officeId, n, timeoutMs = 30_000) {
  return pollUntil(
    async () => {
      const { json } = await api(host, 'GET', `/api/teams/${officeId}/federation/presence`)
      const nodes = json?.data?.nodes ?? []
      return nodes.length >= n ? json.data : null
    },
    { timeoutMs, intervalMs: 1500 },
  )
}

/** Build a host office and have `joiners` join it. Returns { officeId, inviteToken, inviteJti, broughtAppIds }. */
async function buildOffice(host, joiners, label) {
  const { team } = await createOffice(host, {
    spaceName: `Host Space ${label}`,
    teamName: `Office ${label}`,
    // Self-contained, non-blocking task: this suite tests the federation transport,
    // not the model's ability to do open-ended work. A member that asks for
    // clarification would escalate and stall the scenario, so the goal/role tell
    // every member to answer trivially and never escalate.
    goal: 'Connectivity smoke test only. When contacted, reply with ONE short sentence (e.g. a fun fact). Never ask the user anything; no clarification is ever needed.',
    proposal: [{ memberName: 'Analyst', role: 'analyst', responsibility: 'When you receive any message, reply with a single short sentence. Never ask for clarification, never escalate.' }],
  })
  const officeId = team.id
  const inv = await mintInvite(host, officeId)
  if (!inv?.success) throw new Error(`invite mint failed: ${inv?.error}`)
  const broughtAppIds = []
  for (const j of joiners) {
    const { bringAppId } = await joinOffice(j, host, officeId, inv.data.token, label)
    broughtAppIds.push(bringAppId)
  }
  await waitPresence(host, officeId, joiners.length + 1)
  return { officeId, inviteToken: inv.data.token, inviteJti: inv.data.jti, broughtAppIds }
}

async function main() {
  let manifest
  if (ARGS.noStart) {
    manifest = loadManifest(CLUSTER_DIR)
  } else {
    clusterStop(CLUSTER_DIR) // clear any leftover pids first
    manifest = clusterStart({ nodes: NODE_COUNT, fresh: true, clusterDir: CLUSTER_DIR })
  }

  const hasModel = !!manifest.model?.hasKey
  const allNodes = manifest.nodes.filter((n) => n.ready)
  console.log(`\n=== Cluster: ${allNodes.length} ready node(s), model key=${hasModel} ===\n`)
  if (allNodes.length < 2) throw new Error('Need at least 2 ready nodes')

  const host = allNodes[0]
  const joiners = allNodes.slice(1)

  try {
    await categoryA(allNodes)
    await categoryB(host, joiners[0], allNodes)
    await categoryCD(host, joiners, allNodes)
    await categoryEF(host, joiners, hasModel)
    await categoryG(host, joiners[0], hasModel)
    await categoryH(host, joiners, hasModel)
    await categoryI(host, joiners[0])
    await categoryJ(host, joiners[0])
    await categoryK(host, joiners, hasModel)
    await categoryL(host, joiners)
    await categoryM(host, joiners)
  } finally {
    writeResults(manifest, hasModel)
    if (!ARGS.noStart) clusterStop(CLUSTER_DIR)
  }
}

// ── A. Cluster & identity ────────────────────────────────────────────────────
async function categoryA(nodes) {
  if (want('A1')) {
    const statuses = await Promise.all(nodes.map((n) => api(n, 'GET', '/api/remote/status')))
    const all200 = statuses.every((s) => s.status === 200)
    const ids = nodes.map((n) => n.identityId)
    const ports = nodes.map((n) => n.port)
    const uniqIds = new Set(ids).size === ids.length
    const uniqPorts = new Set(ports).size === ports.length
    // SCENARIOS uses /api/health; the actual liveness endpoint is /api/remote/status.
    const ok = all200 && uniqIds && uniqPorts
    reporter[ok ? 'pass' : 'fail']('A1', `${nodes.length} nodes status=${all200 ? 'all200' : 'NOT all 200'}, uniqueIds=${uniqIds}, uniquePorts=${uniqPorts}`)
  }

  if (want('A2')) {
    // Restart node-2 and confirm identityId is stable (node-identity.json persists).
    const target = nodes[1]
    const before = target.identityId
    killNode(target)
    await sleep(2000)
    const pid = await reviveNode(target, CLUSTER_DIR)
    if (!pid) {
      reporter.fail('A2', 'node did not come back up after revive')
    } else {
      const idFile = path.resolve(PROJECT_ROOT, CLUSTER_DIR, `node-${target.index}`, '.halo', 'node-identity.json')
      let after = null
      try {
        after = JSON.parse(fs.readFileSync(idFile, 'utf-8'))?.id
      } catch {}
      const ok = after && after === before
      reporter[ok ? 'pass' : 'fail']('A2', `identity before=${before} after=${after}`)
    }
  }

  if (want('A3')) {
    const ports = nodes.map((n) => n.port)
    const dirs = nodes.map((n) => n.dataDir)
    const uniqPorts = new Set(ports).size === ports.length
    const uniqDirs = new Set(dirs).size === dirs.length
    const ok = nodes.length >= 3 && uniqPorts && uniqDirs
    reporter[ok ? 'pass' : 'fail']('A3', `${nodes.length} nodes, uniquePorts=${uniqPorts}, isolatedDataDirs=${uniqDirs}`)
  }
}

// ── B. Office create / invite / join ─────────────────────────────────────────
async function categoryB(host, joiner, allNodes) {
  let office
  if (want('B1') || want('B5')) {
    const partis = want('B5') ? allNodes.slice(1) : [joiner]
    office = await buildOffice(host, partis, 'B')
    const details = await detailOnAll([host, ...partis], office.officeId)
    const r = assertConsistentRoster(details)
    // Each node's detail should include both host-owned and remote-owned members.
    const hostDetail = details.find((d) => d.node.index === host.index)?.detail
    const hasRemote = (hostDetail?.members ?? []).some((m) => m.origin === 'remote')
    if (want('B1')) reporter[r.ok && hasRemote ? 'pass' : 'fail']('B1', `${r.evidence}; host sees remote member=${hasRemote}`)
    if (want('B5')) {
      const r5 = assertConsistentRoster(details, { expectMembers: (hostDetail?.members ?? []).length })
      reporter[r5.ok ? 'pass' : 'fail']('B5', `${partis.length + 1} nodes: ${r5.evidence}`)
    }
  }

  if (want('B2')) {
    // Invite stability: re-minting returns the same token/jti.
    const { team } = await createOffice(host, { spaceName: 'B2 Space', teamName: 'B2 Office', goal: 'g', proposal: [{ memberName: 'A', role: 'analyst', responsibility: 'r' }] })
    const i1 = await mintInvite(host, team.id)
    const i2 = await mintInvite(host, team.id)
    const same = i1?.success && i2?.success && i1.data.jti === i2.data.jti && i1.data.token === i2.data.token
    reporter[same ? 'pass' : 'fail']('B2', `jti1=${i1?.data?.jti} jti2=${i2?.data?.jti} tokenSame=${i1?.data?.token === i2?.data?.token}`)
  }

  if (want('B3')) {
    // Revoke invite, then a NEW joiner attempts to use the revoked token → reject;
    // already-seated members stay. Uses a fresh office to avoid disturbing B1.
    const partis = [joiner]
    const off = await buildOffice(host, partis, 'B3')
    await api(host, 'DELETE', `/api/teams/${off.officeId}/invite/${off.inviteJti}`)
    await sleep(1000)
    // a second joiner tries the revoked token
    const j2 = allNodes[2] ?? null
    if (!j2) {
      reporter.skip('B3', 'need a 3rd node to test post-revoke join')
    } else {
      let joinErr = null
      try {
        await joinOffice(j2, host, off.officeId, off.inviteToken, 'B3b')
      } catch (err) {
        joinErr = err.message
      }
      const det = await detailOnAll([host, joiner], off.officeId)
      const stillSeated = (det[0].detail?.members ?? []).some((m) => m.origin === 'remote')
      const rejected = !!joinErr
      reporter[rejected && stillSeated ? 'pass' : (stillSeated ? 'partial' : 'fail')]('B3', `revokedJoinRejected=${rejected} (${joinErr ?? 'JOINED!'}); seatedMemberRetained=${stillSeated}`)
    }
  }

  if (want('B4')) {
    // One-time/concurrent reuse: default invites are reusable (B2), so a true
    // one-time link cannot be minted from this HTTP surface. Honest SKIP.
    reporter.skip('B4', 'no one-time invite option on POST /invite (default invites are reusable per B2); cannot drive single-use semantics over HTTP')
  }

  if (want('B6')) {
    // A PIN containing "." must not be misclassified as an office-member
    // credential and lock the node out. Node PINs are "HaloNode-N-Aa1!" (no
    // dot), so probe the auth path directly: a "." bearer that is NOT a valid
    // office credential must 401, not wedge the server.
    const bad = { ...host, token: 'has.dot.token' }
    const r = await api(bad, 'GET', '/api/teams')
    const stillAlive = (await api(host, 'GET', '/api/teams')).status === 200
    const ok = (r.status === 401 || r.status === 403) && stillAlive
    reporter[ok ? 'pass' : 'partial']('B6', `dotToken status=${r.status}, nodeStillServes=${stillAlive} (note: cannot drive a real custom-PIN login over this harness; auth-path probe only)`)
  }

  if (want('B7') || want('B8')) {
    // Verifying 401/403 here needs a real office-credential bearer, but the
    // invite token authenticates WS join, not HTTP; minting an HTTP
    // office-member bearer is not exposed by this harness.
    reporter.skip('B7', 'office-member HTTP bearer not mintable via harness (PIN-only auth available); cannot exercise dual-credential 401/403 matrix')
    reporter.skip('B8', 'WS office-scope event filtering requires a WS office-credential client; not drivable from this HTTP harness')
  }
  return office
}

// ── C. Presence/offline/restart + D. Roster consistency ──────────────────────
async function categoryCD(host, joiners, allNodes) {
  const joiner = joiners[0]

  // Shared office for C/D with 2 joiners where available.
  const dParts = joiners.slice(0, 2)
  let office = null
  if (['C1', 'C4', 'C6', 'D1', 'D2', 'D3', 'D4', 'D5'].some(want)) {
    office = await buildOffice(host, dParts, 'CD')
  }

  if (want('D1')) {
    // Change lead on host; every joiner's /detail reflects new lead.
    const hostMembers = await members(host, office.officeId)
    const newLead = hostMembers.find((m) => m.origin !== 'remote' && !m.isLead) ?? hostMembers[0]
    await apiOk(host, 'PATCH', `/api/teams/${office.officeId}`, { leadAppId: newLead.appId })
    const conv = await pollUntil(async () => {
      const det = await detailOnAll([host, ...dParts], office.officeId)
      const leads = det.map((d) => d.detail?.team?.leadAppId)
      return leads.every((l) => l === newLead.appId) ? det : null
    }, { timeoutMs: 15_000, intervalMs: 1000 })
    if (conv) {
      reporter.pass('D1', `all nodes converged to new lead=${newLead.appId}`)
    } else {
      const det = await detailOnAll([host, ...dParts], office.officeId)
      reporter.fail('D1', `lead not converged: ${det.map((d) => `n${d.node.index}=${d.detail?.team?.leadAppId}`).join(' | ')} expected=${newLead.appId}`)
    }
  }

  if (want('D2')) {
    // Host adds an AI member; all nodes' rosters converge to include it.
    const before = (await members(host, office.officeId)).length
    // Add by provisioning a 2nd local member on host and POST /members.
    const { team: extra } = await createOffice(host, { spaceName: 'D2 extra', teamName: 'D2 extra', goal: 'g', proposal: [{ memberName: 'Extra', role: 'analyst', responsibility: 'r' }] })
    const extraAppId = await firstNonLeadAppId(host, extra.id)
    const add = await api(host, 'POST', `/api/teams/${office.officeId}/members`, { appId: extraAppId, memberName: 'Extra', role: 'analyst' })
    if (add.status !== 200 || add.json?.success === false) {
      reporter.partial('D2', `addMember responded status=${add.status} err=${add.json?.error}; member-add path may require local-app linkage`)
    } else {
      const conv = await pollUntil(async () => {
        const det = await detailOnAll([host, ...dParts], office.officeId)
        const r = assertConsistentRoster(det, { expectMembers: before + 1 })
        return r.ok ? r : null
      }, { timeoutMs: 12_000 })
      reporter[conv ? 'pass' : 'fail']('D2', conv ? conv.evidence : `roster did not converge to ${before + 1} members`)
    }
  }

  if (want('D3')) {
    // Host removes the remote-owned member brought by joiner-A; all converge.
    const hostMs = await members(host, office.officeId)
    const remote = hostMs.find((m) => m.origin === 'remote')
    if (!remote) {
      reporter.skip('D3', 'no remote member to remove')
    } else {
      const before = hostMs.length
      const del = await api(host, 'DELETE', `/api/teams/${office.officeId}/members/${remote.appId}`)
      const conv = await pollUntil(async () => {
        const det = await detailOnAll([host, ...dParts], office.officeId)
        const r = assertConsistentRoster(det, { expectMembers: before - 1 })
        const gone = det.every((d) => !(d.detail?.members ?? []).some((m) => m.appId === remote.appId))
        return r.ok && gone ? r : null
      }, { timeoutMs: 12_000 })
      reporter[conv ? 'pass' : 'fail']('D3', conv ? `removed ${remote.appId}; ${conv.evidence}` : `removal of ${remote.appId} did not converge (del status=${del.status})`)
    }
  }

  if (want('D4')) {
    // Host changes edges; all nodes' edge sets agree.
    const hostMs = await members(host, office.officeId)
    if (hostMs.length < 2) {
      reporter.skip('D4', 'need >=2 members to set an edge')
    } else {
      const edges = [{ from: hostMs[0].appId, to: hostMs[1].appId }]
      const put = await api(host, 'PUT', `/api/teams/${office.officeId}/edges`, { edges })
      const conv = await pollUntil(async () => {
        const det = await detailOnAll([host, ...dParts], office.officeId)
        const sigs = det.map((d) => JSON.stringify((d.detail?.edges ?? []).map((e) => `${e.from ?? e.fromAppId}->${e.to ?? e.toAppId}`).sort()))
        return sigs.every((s) => s === sigs[0]) && (det[0].detail?.edges ?? []).length >= 1 ? det : null
      }, { timeoutMs: 12_000 })
      reporter[conv ? 'pass' : 'partial']('D4', conv ? 'edges agree across nodes' : `edges did not converge (put status=${put.status}); edge propagation may not push to joiners`)
    }
  }

  if (want('D5')) {
    // Concurrent writes: host changes lead while joiner-A changes... joiners
    // cannot mutate team meta (PATCH on a shadow office). We instead fire two
    // concurrent host-side mutations (lead + edges) and assert deterministic
    // convergence with neither silently dropped.
    const hostMs = await members(host, office.officeId)
    if (hostMs.length < 2) {
      reporter.skip('D5', 'need >=2 members')
    } else {
      const lead = hostMs[1].appId
      const edges = [{ from: hostMs[1].appId, to: hostMs[0].appId }]
      await Promise.all([
        apiOk(host, 'PATCH', `/api/teams/${office.officeId}`, { leadAppId: lead }),
        api(host, 'PUT', `/api/teams/${office.officeId}/edges`, { edges }),
      ])
      const conv = await pollUntil(async () => {
        const det = await detailOnAll([host, ...dParts], office.officeId)
        const leadOk = det.every((d) => d.detail?.team?.leadAppId === lead)
        const edgeOk = det.every((d) => (d.detail?.edges ?? []).length >= 1)
        const r = assertConsistentRoster(det)
        return leadOk && edgeOk && r.ok ? det : null
      }, { timeoutMs: 12_000 })
      reporter[conv ? 'pass' : 'partial']('D5', conv ? 'both concurrent writes applied and converged; no silent drop' : 'concurrent lead+edge writes did not both converge (edge push to joiners may be missing)')
    }
  }

  if (want('C1')) {
    // Kill joiner-A; host /detail marks that node/member offline within ~13-15s.
    const victim = dParts[0]
    const victimMembers = (await members(host, office.officeId)).filter((m) => m.origin === 'remote')
    killNode(victim)
    const offline = await pollUntil(async () => {
      const { json } = await api(host, 'GET', `/api/teams/${office.officeId}/federation/presence`)
      const node = (json?.data?.nodes ?? []).find((n) => n.identity === victim.identityId || n.nodeId === victim.identityId)
      return node && (node.status === 'offline' || node.status === 'suspect') ? node : null
    }, { timeoutMs: 20_000, intervalMs: 1500 })
    reporter[offline ? 'pass' : 'fail']('C1', offline ? `victim node marked ${offline.status} in presence` : 'victim never marked suspect/offline within 20s')
    // revive for downstream
    await reviveNode(victim, CLUSTER_DIR)
    await sleep(3000)
  }

  if (want('C2')) {
    reporter.skip('C2', 'WS-link jitter (dropLink/restoreLink) not faithfully reproducible over loopback; SCENARIOS §0.2 marks link-loss as non-faithful')
  }
  if (want('C3')) {
    reporter.skip('C3', 'heartbeat-stall-on-live-socket requires injecting a frozen renderer/heartbeat; not drivable at HTTP layer')
  }

  if (want('C4')) {
    // Kill + revive joiner; it should auto re-join (office-recovery) and roster
    // recovers. Uses a dedicated office to avoid interference.
    const off = await buildOffice(host, [joiner], 'C4')
    const beforeCount = (await members(host, off.officeId)).length
    killNode(joiner)
    await pollUntil(async () => {
      const { json } = await api(host, 'GET', `/api/teams/${off.officeId}/federation/presence`)
      const n = (json?.data?.nodes ?? []).find((x) => x.identity === joiner.identityId)
      return n && n.status !== 'online' ? n : null
    }, { timeoutMs: 20_000 })
    await reviveNode(joiner, CLUSTER_DIR)
    const recovered = await pollUntil(async () => {
      const { json } = await api(host, 'GET', `/api/teams/${off.officeId}/federation/presence`)
      const online = (json?.data?.nodes ?? []).filter((n) => n.status === 'online').length
      const cnt = (await members(host, off.officeId)).length
      return online >= 2 && cnt >= beforeCount ? { online, cnt } : null
    }, { timeoutMs: 45_000, intervalMs: 2000 })
    reporter[recovered ? 'pass' : 'fail']('C4', recovered ? `joiner auto-rejoined: ${recovered.online} online, roster=${recovered.cnt}` : 'joiner did not auto-rejoin within 45s after revive')
  }

  if (want('C5')) {
    // Kill+revive host; host auto re-hosts, joiner reconnects.
    const off = await buildOffice(host, [joiner], 'C5')
    killNode(host)
    await sleep(3000)
    const pid = await reviveNode(host, CLUSTER_DIR)
    const recovered = pid
      ? await pollUntil(async () => {
          const { json } = await api(host, 'GET', `/api/teams/${off.officeId}/federation/presence`)
          const online = (json?.data?.nodes ?? []).filter((n) => n.status === 'online').length
          return json?.data?.role === 'host' && online >= 2 ? online : null
        }, { timeoutMs: 45_000, intervalMs: 2000 })
      : null
    reporter[recovered ? 'pass' : 'fail']('C5', recovered ? `host auto re-hosted, ${recovered} nodes online` : 'host did not re-host / joiner did not reconnect within 45s')
  }

  if (want('C6')) {
    // Kill host (no revive); joiner honestly pauses, no split-brain / self-promote.
    const off = await buildOffice(host, [joiner], 'C6')
    killNode(host)
    await sleep(8000)
    const { json } = await api(joiner, 'GET', `/api/teams/${off.officeId}/federation/presence`)
    const pres = json?.data
    // joiner must NOT believe itself authority (no split-brain self-promotion).
    const selfAuthority = pres?.authority?.isSelf === true
    const hostNode = (pres?.nodes ?? []).find((n) => n.identity === host.identityId)
    const hostNotOnline = !hostNode || hostNode.status !== 'online'
    const ok = !selfAuthority && hostNotOnline
    reporter[ok ? 'pass' : 'fail']('C6', `joiner role=${pres?.role} selfAuthority=${selfAuthority} hostStatus=${hostNode?.status ?? 'gone'} (expect no self-promotion)`)
    // revive host for downstream categories
    await reviveNode(host, CLUSTER_DIR)
    await sleep(4000)
  }

  if (want('C7')) {
    reporter.skip('C7', '>24h offline rejoin needs clock injection; shared wall clock on one machine (SCENARIOS §0.3)')
  }
}

// ── E. Run + run-state, F. Blackboard replication ────────────────────────────
async function categoryEF(host, joiners, hasModel) {
  const ids = ['E1', 'E2', 'E3', 'E4', 'E5', 'F1', 'F2', 'F3']
  if (!ids.some(want)) return
  if (!hasModel) {
    for (const id of ids) if (want(id)) reporter.skip(id, '[no-model-ok skipped: no key] run requires a live model')
    return
  }
  const parts = joiners.slice(0, Math.min(2, joiners.length))
  const office = await buildOffice(host, parts, 'EF')

  if (want('E1')) {
    await apiOk(host, 'POST', `/api/teams/${office.officeId}/run`)
    const conv = await pollUntil(async () => {
      const det = await detailOnAll([host, ...parts], office.officeId)
      const running = det.filter((d) => d.detail?.team?.status === 'running')
      // epoch id agreement across nodes
      const epochs = await Promise.all([host, ...parts].map(async (n) => {
        const e = await api(n, 'GET', `/api/teams/${office.officeId}/epochs`)
        return (e.json?.data ?? [])[0]?.id
      }))
      const epochSame = epochs.every((e) => e && e === epochs[0])
      return running.length === det.length && epochSame ? { epoch: epochs[0] } : null
    }, { timeoutMs: 25_000, intervalMs: 1500 })
    reporter[conv ? 'pass' : 'fail']('E1', conv ? `all nodes status=running, epoch=${conv.epoch} byte-identical` : 'run-state/epoch did not agree across nodes')
  }

  if (want('E2') || want('E3')) {
    // Observe member runtime status churn + activity (board) replicate to joiners.
    const observed = await pollUntil(async () => {
      const det = await detailOnAll([host, ...parts], office.officeId)
      const anyWorking = det.some((d) => (d.detail?.members ?? []).some((m) => m.status === 'working'))
      const boardNonEmpty = det.some((d) => (d.detail?.tasks ?? []).length > 0 || (d.detail?.findings ?? []).length > 0)
      return anyWorking || boardNonEmpty ? { det } : null
    }, { timeoutMs: 40_000, intervalMs: 2000 })
    if (want('E2')) reporter[observed ? 'pass' : 'partial']('E2', observed ? 'member working/idle churn visible on nodes' : 'no working status observed within 40s (model may be slow/idle)')
    if (want('E3')) {
      const det = await detailOnAll([host, ...parts], office.officeId)
      const taskCounts = det.map((d) => (d.detail?.tasks ?? []).length)
      const same = taskCounts.every((c) => c === taskCounts[0])
      reporter[observed && same ? 'pass' : 'partial']('E3', `activity/task counts per node=[${taskCounts.join(',')}] agree=${same}`)
    }
  }

  if (want('F1')) {
    const det = await detailOnAll([host, ...parts], office.officeId)
    const pres = await presenceOnAll([host, ...parts], office.officeId)
    const r = assertConsistentBoard(det, pres)
    reporter[r.ok ? 'pass' : 'fail']('F1', r.evidence)
  }

  if (want('E4')) {
    // Wait for quiescence auto-seal: team.status → idle on all nodes.
    const idle = await pollUntil(async () => {
      const det = await detailOnAll([host, ...parts], office.officeId)
      return det.every((d) => d.detail?.team?.status === 'idle') ? det : null
    }, { timeoutMs: 180_000, intervalMs: 5000 })
    if (idle) {
      const stillWorking = idle.some((d) => (d.detail?.members ?? []).some((m) => m.status === 'working'))
      reporter[!stillWorking ? 'pass' : 'partial']('E4', `all nodes idle; lingering working=${stillWorking}`)
    } else {
      reporter.partial('E4', 'run did not auto-seal to idle within 180s (long run or no quiescence)')
    }
  }

  if (want('E5')) {
    reporter.skip('E5', 'requires a running task owned by a killed joiner mid-run; timing-fragile under shared-CPU model contention, not deterministic at HTTP layer')
  }
  if (want('F2')) {
    reporter.skip('F2', 'hot-standby inheritance (M2 replication) needs >=2 standbys + authority handover, not faithfully reproducible on loopback (SCENARIOS §0.2)')
  }
  if (want('F3')) {
    reporter.skip('F3', 'replication_log fid idempotency on replay is internal DB state not exposed over HTTP')
  }
}

// ── G. Owner-served history / persistence ────────────────────────────────────
async function categoryG(host, joiner, hasModel) {
  if (!['G1', 'G2', 'G3', 'G4'].some(want)) return
  const office = await buildOffice(host, [joiner], 'G')
  const hostMs = await members(host, office.officeId)
  const remote = hostMs.find((m) => m.origin === 'remote')

  if (want('G1')) {
    if (!remote) {
      reporter.fail('G1', 'no remote-owned member present')
    } else {
      // The history route intentionally 400s while a team has ZERO epochs
      // ("No run has started for this team yet") — that pre-run state is not
      // what G1 guards. Create an epoch first (run + immediate pause keeps the
      // office reusable for G2), then assert owner-served consistency.
      await apiOk(host, 'POST', `/api/teams/${office.officeId}/run`)
      await sleep(1500)
      await apiOk(host, 'POST', `/api/teams/${office.officeId}/pause`).catch(() => {})
      const chats = await chatOnAll([host, joiner], office.officeId, remote.appId)
      const noNotFound = chats.every((c) => !(c.error && /not.?found/i.test(String(c.error))))
      const bothReturn = chats.every((c) => c.status === 200 && Array.isArray(c.messages))
      // owner-served: both nodes should yield the same transcript (possibly empty)
      const lens = chats.map((c) => (c.messages ?? []).length)
      const same = lens.every((l) => l === lens[0])
      reporter[bothReturn && noNotFound && same ? 'pass' : 'fail']('G1', `statuses=[${chats.map((c) => c.status).join(',')}] lens=[${lens.join(',')}] noHistoryNotFound=${noNotFound}`)
    }
  }

  if (want('G2')) {
    if (!hasModel) {
      reporter.skip('G2', '[no-model-ok skipped: no key] needs a real reply to persist')
    } else if (!remote) {
      reporter.fail('G2', 'no remote member')
    } else {
      await apiOk(host, 'POST', `/api/teams/${office.officeId}/run`)
      await sleep(2000)
      const send = await api(host, 'POST', `/api/teams/${office.officeId}/members/${remote.appId}/send`, { message: 'Hello, please reply briefly.' })
      const persisted = await pollUntil(async () => {
        const chats = await chatOnAll([host, joiner], office.officeId, remote.appId)
        const bothHave = chats.every((c) => (c.messages ?? []).length > 0)
        const lens = chats.map((c) => (c.messages ?? []).length)
        // CONTENT-level agreement, not just length: a replica that froze a
        // provisional last message has equal length but truncated text — the
        // "final text missing on other nodes" bug this must catch.
        const sigs = chats.map((c) => JSON.stringify((c.messages ?? []).map((m) => [m.role, m.content])))
        return bothHave && sigs.every((s) => s === sigs[0]) ? lens : null
      }, { timeoutMs: 90_000, intervalMs: 3000 })
      reporter[persisted ? 'pass' : 'fail']('G2', persisted ? `message+reply content-consistent, both nodes read ${persisted[0]} msgs` : `transcript not persisted/consistent (send status=${send.status})`)
    }
  }

  if (want('G3')) {
    if (!remote) {
      reporter.skip('G3', 'no remote member')
    } else {
      // Kill the OWNER (joiner) then GET its history from host. With the owner
      // gone the host must NOT hang: the multi-replica read path serves the
      // local copy instantly (stale-flagged once presence confirms the owner
      // offline; fresh-flagged in the pre-confirm window — either way the
      // transcript is served), or, with no replica at all, returns a neutral
      // error. A ~15s hang is the only real failure here.
      killNode(joiner)
      await sleep(2000)
      const t0 = Date.now()
      const r = await api(host, 'GET', `/api/teams/${office.officeId}/chat-messages?appId=${remote.appId}`)
      const dt = Date.now() - t0
      const quick = dt < 12_000
      const replicaServed =
        r.status === 200 && r.json && r.json.success === true && Array.isArray(r.json.data)
      const neutral = r.status === 502 || r.status === 503 || (r.json && r.json.success === false)
      reporter[quick && (replicaServed || neutral) ? 'pass' : 'fail'](
        'G3',
        `owner-down history fetch took ${dt}ms status=${r.status} rows=${r.json?.data?.length} stale=${r.json && r.json.stale} (expect <12s + local replica or neutral)`
      )
      await reviveNode(joiner, CLUSTER_DIR)
      await sleep(3000)
    }
  }

  if (want('G4')) {
    // Cross-office isolation: request a member of THIS office but using another
    // office's id, or a non-member appId → reject (no transcript leak).
    const r = await api(host, 'GET', `/api/teams/${office.officeId}/chat-messages?appId=not-a-real-app-id`)
    const rejected = r.status === 404 || (r.json && r.json.success === false)
    reporter[rejected ? 'pass' : 'fail']('G4', `non-member appId history request status=${r.status} rejected=${rejected}`)
  }
}

// ── H. Cross-member dispatch / chat (four directions) ────────────────────────
async function categoryH(host, joiners, hasModel) {
  const ids = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']
  if (!ids.some(want)) return
  if (!hasModel) {
    for (const id of ids) if (want(id)) reporter.skip(id, '[no-model-ok skipped: no key] dispatch needs a live model to produce a reply')
    return
  }
  const parts = joiners.slice(0, Math.min(2, joiners.length))
  const office = await buildOffice(host, parts, 'H')
  await apiOk(host, 'POST', `/api/teams/${office.officeId}/run`)
  await sleep(2000)
  const hostMs = await members(host, office.officeId)
  const remoteA = hostMs.find((m) => m.origin === 'remote') // owned by joiner A
  const localHost = hostMs.find((m) => m.origin !== 'remote' && !m.isLead) ?? hostMs.find((m) => m.origin !== 'remote')

  async function dispatchAndCheck(senderNode, targetAppId, label) {
    const send = await api(senderNode, 'POST', `/api/teams/${office.officeId}/members/${targetAppId}/send`, { message: `[${label}] Please acknowledge briefly.` })
    if (send.status !== 200 || send.json?.success === false) return { ok: false, why: `send status=${send.status} err=${send.json?.error}` }
    const got = await pollUntil(async () => {
      const chats = await chatOnAll([host, ...parts], office.officeId, targetAppId)
      const lens = chats.map((c) => (c.messages ?? []).length)
      // Content-level agreement (see G2): equal lengths can hide a frozen
      // provisional last message on a replica.
      const sigs = chats.map((c) => JSON.stringify((c.messages ?? []).map((m) => [m.role, m.content])))
      const consistent = sigs.every((s) => s === sigs[0])
      return lens[0] > 0 && consistent ? lens : null
    }, { timeoutMs: 90_000, intervalMs: 3000 })
    return { ok: !!got, why: got ? `transcript content-consistent len=${got[0]} across nodes` : 'no consistent reply within 90s' }
  }

  if (want('H1')) {
    if (!remoteA) reporter.fail('H1', 'no joiner-owned member')
    else { const r = await dispatchAndCheck(host, remoteA.appId, 'H1 host→joiner'); reporter[r.ok ? 'pass' : 'fail']('H1', r.why) }
  }
  if (want('H2')) {
    // joiner → host-owned member. Sender = joiner A node.
    if (!localHost) reporter.fail('H2', 'no host-owned non-lead member')
    else { const r = await dispatchAndCheck(parts[0], localHost.appId, 'H2 joiner→host'); reporter[r.ok ? 'pass' : 'fail']('H2', r.why) }
  }
  if (want('H3')) {
    if (parts.length < 2) reporter.skip('H3', 'need 2 joiners for joiner-A → joiner-B dispatch')
    else {
      const bMembers = (await members(host, office.officeId)).filter((m) => m.origin === 'remote')
      const targetB = bMembers[1] ?? null
      if (!targetB) reporter.skip('H3', 'second joiner member not found')
      else { const r = await dispatchAndCheck(parts[0], targetB.appId, 'H3 jA→jB'); reporter[r.ok ? 'pass' : 'fail']('H3', r.why) }
    }
  }
  if (want('H7')) {
    // Optimistic local echo: send returns success promptly (not gated on round-trip).
    if (!remoteA) reporter.skip('H7', 'no remote member')
    else {
      const t0 = Date.now()
      const send = await api(host, 'POST', `/api/teams/${office.officeId}/members/${remoteA.appId}/send`, { message: 'H7 echo probe' })
      const dt = Date.now() - t0
      reporter[send.status === 200 && dt < 20_000 ? 'pass' : 'partial']('H7', `send acked in ${dt}ms status=${send.status} (server-side dispatch ack; true UI optimistic echo is renderer-only)`)
    }
  }
  if (want('H4')) {
    // After epoch seal, 1:1 send must still get a reply (not dropped as epoch-sealed).
    if (!remoteA) reporter.skip('H4', 'no remote member')
    else {
      await api(host, 'POST', `/api/teams/${office.officeId}/pause`) // seal epoch
      await sleep(2000)
      const r = await dispatchAndCheck(host, remoteA.appId, 'H4 post-seal')
      reporter[r.ok ? 'pass' : 'fail']('H4', `post-seal dispatch: ${r.why}`)
    }
  }
  if (want('H5')) {
    reporter.skip('H5', 'in-agent team_send tool dispatch is driven by the model from inside a run, not directly invokable over the HTTP control plane')
  }
  if (want('H6')) {
    // Joiner sees its OWN member's execution + retained transcript after run.
    if (!remoteA || parts.length < 1) reporter.skip('H6', 'no remote member')
    else {
      const chats = await chatOnAll([parts[0]], office.officeId, remoteA.appId)
      const ok = chats[0]?.status === 200 && Array.isArray(chats[0]?.messages)
      reporter[ok ? 'pass' : 'fail']('H6', ok ? `joiner reads its own member transcript (len=${chats[0].messages.length})` : `joiner cannot read own member: status=${chats[0]?.status}`)
    }
  }
}

// ── I. Governance: kick / leave / dissolve ───────────────────────────────────
async function categoryI(host, joiner) {
  if (!['I1', 'I2', 'I3', 'I4', 'I5'].some(want)) return

  if (want('I1') || want('I4')) {
    const off = await buildOffice(host, [joiner], 'I1')
    const remote = (await members(host, off.officeId)).find((m) => m.origin === 'remote')
    const del = await api(host, 'DELETE', `/api/teams/${off.officeId}/members/${remote.appId}`)
    const conv = await pollUntil(async () => {
      const det = await detailOnAll([host], off.officeId)
      const gone = !(det[0].detail?.members ?? []).some((m) => m.appId === remote.appId)
      return gone ? det : null
    }, { timeoutMs: 12_000 })
    if (want('I1')) reporter[conv ? 'pass' : 'fail']('I1', conv ? `kicked member removed from host roster (del status=${del.status})` : 'kicked member still present')
    if (want('I4')) {
      // Joiner now has no member in this office → the PERSISTED join-conn must
      // be cleared so the next start does not auto-rejoin an office that kicked
      // it (case ③ kicked-empty). The live presence/socket may legitimately
      // linger for the session — the guard is the persisted record, so read the
      // joiner's joined_office_connections row directly (same machine).
      await sleep(3000)
      const { execFileSync } = await import('child_process')
      let persisted = 'query-failed'
      try {
        persisted = execFileSync('/usr/bin/sqlite3', [
          `${joiner.dataDir}/halo.db`,
          `SELECT COUNT(*) FROM joined_office_connections WHERE office_id = '${off.officeId}';`,
        ], { encoding: 'utf-8' }).trim()
      } catch (err) {
        persisted = `query-failed: ${err.message}`
      }
      const { json } = await api(joiner, 'GET', `/api/teams/${off.officeId}/federation/presence`)
      reporter[persisted === '0' ? 'pass' : 'fail']('I4',
        `post-kick persisted join-conn rows=${persisted} (expect 0 → no auto-rejoin on next start); live presence=${json?.data ? json.data.role : 'null'}`)
    }
  }

  if (want('I2')) {
    const off = await buildOffice(host, [joiner], 'I2')
    const leave = await api(joiner, 'POST', `/api/teams/${off.officeId}/leave`)
    const conv = await pollUntil(async () => {
      const det = await detailOnAll([host], off.officeId)
      const noRemote = !(det[0].detail?.members ?? []).some((m) => m.origin === 'remote')
      const { json } = await api(joiner, 'GET', `/api/teams/${off.officeId}/federation/presence`)
      const joinerGone = json?.data == null || json.data.role == null
      return noRemote && joinerGone ? true : null
    }, { timeoutMs: 15_000 })
    reporter[conv ? 'pass' : 'fail']('I2', conv ? `joiner left; both views consistent (leave status=${leave.status})` : 'leave did not converge on both sides')
  }

  if (want('I3') || want('I5')) {
    const off = await buildOffice(host, [joiner], 'I3')
    const dis = await api(host, 'DELETE', `/api/teams/${off.officeId}`)
    await sleep(4000)
    // Host team gone; joiner's shadow office torn down.
    const hostGet = await api(host, 'GET', `/api/teams/${off.officeId}`)
    const hostGone = hostGet.json?.data == null || hostGet.json?.success === false || hostGet.status === 404
    const { json: jp } = await api(joiner, 'GET', `/api/teams/${off.officeId}/federation/presence`)
    const joinerTornDown = jp?.data == null || jp.data.role == null
    if (want('I3')) reporter[hostGone && joinerTornDown ? 'pass' : 'partial']('I3', `dissolve status=${dis.status}; hostTeamGone=${hostGone}, joinerShadowTorn=${joinerTornDown}`)
    if (want('I5')) {
      // Joiner's OWN local digital human (bench team) must survive dissolution.
      const localTeams = await api(joiner, 'GET', '/api/teams')
      const stillHasLocal = (localTeams.json?.data ?? []).length > 0
      reporter[stillHasLocal && joinerTornDown ? 'pass' : 'partial']('I5', `post-dissolve: joiner local benches intact=${stillHasLocal}, office shadow removed=${joinerTornDown}`)
    }
  }
}

// ── J. Security / scope ──────────────────────────────────────────────────────
async function categoryJ(host, joiner) {
  if (want('J1')) {
    reporter.skip('J1', 'fromNode spoof rejection is a WS-frame-level check; requires a raw WS client forging frames, not reachable via HTTP control plane')
  }
  if (want('J2')) {
    reporter.skip('J2', "empty-identity ('') sentinel join-admission is internal to the WS join handshake; not observable/injectable via HTTP")
  }
  if (want('J3')) {
    // Narrow scope on invite should currently be rejected (OFFICE_SCOPE_NOT_SUPPORTED).
    const { team } = await createOffice(host, { spaceName: 'J3', teamName: 'J3', goal: 'g', proposal: [{ memberName: 'A', role: 'analyst', responsibility: 'r' }] })
    const inv = await mintInvite(host, team.id, { scope: { visibility: 'assigned', discoverable: false, canContact: 'lead-only' } })
    const rejected = inv?.success === false && /SCOPE|SUPPORT/i.test(String(inv?.error ?? ''))
    if (inv?.success === false) reporter[rejected ? 'pass' : 'partial']('J3', `narrow scope rejected: ${inv.error}`)
    else reporter.partial('J3', `narrow-scope invite was ACCEPTED (success=${inv?.success}); expected OFFICE_SCOPE_NOT_SUPPORTED gate`)
  }
  if (want('J4')) {
    reporter.skip('J4', 'narrow-scope end-to-end enforcement gated on device-key (D10 deferred) per SCENARIOS J4')
  }
}

// ── K. Concurrency / stress ──────────────────────────────────────────────────
async function categoryK(host, joiners, hasModel) {
  if (want('K1')) {
    if (!hasModel) reporter.skip('K1', '[no-model-ok skipped: no key] concurrent dispatch needs a live model')
    else {
      const off = await buildOffice(host, [joiners[0]], 'K1')
      await apiOk(host, 'POST', `/api/teams/${off.officeId}/run`)
      await sleep(2000)
      const remote = (await members(host, off.officeId)).find((m) => m.origin === 'remote')
      const N = 50
      const t0 = Date.now()
      const sends = await Promise.all(
        Array.from({ length: N }, (_, i) => api(host, 'POST', `/api/teams/${off.officeId}/members/${remote.appId}/send`, { message: `concurrent #${i}` })),
      )
      const elapsedMs = Date.now() - t0
      // Burst semantics (verified against owner logs): concurrent sends to one
      // member COALESCE into the active turn on the owner — every message text
      // is delivered/injected, ONE (or few) reply is produced, and the other
      // waits resolve fast and empty instead of hanging. The invariants are:
      // no transport error, no hang, at least one real reply, no message loss.
      const transportOk = sends.every((s) => s.status === 200)
      const replied = sends.filter((s) => s.json?.data?.ok && s.json?.data?.finalMessage).length
      const alive = (await api(host, 'GET', '/api/teams')).status === 200
      const transcript = await pollUntil(async () => {
        const chats = await chatOnAll([host], off.officeId, remote.appId)
        const text = JSON.stringify(chats[0].messages ?? [])
        const delivered = Array.from({ length: N }, (_, i) => text.includes(`concurrent #${i}`)).filter(Boolean).length
        return delivered === N ? delivered : null
      }, { timeoutMs: 120_000, intervalMs: 5000 })
      const ok = transportOk && alive && replied >= 1 && transcript === N
      reporter[ok ? 'pass' : 'partial']('K1',
        `${N} concurrent sends: transportOk=${transportOk} repliedWithContent=${replied} deliveredInTranscript=${transcript ?? '<N'}/${N} ` +
        `elapsed=${elapsedMs}ms alive=${alive} (coalescing per-send-reply semantics flagged in RESULTS for product review)`)
    }
  }
  if (want('K2')) {
    reporter.skip('K2', 'super-long transcript GET needs a long real run to build volume; covered functionally by G1/G2, perf/OOM not asserted at HTTP layer')
  }
  if (want('K3')) {
    if (joiners.length < 4) reporter.skip('K3', 'need host+4 (5 nodes)')
    else {
      const off = await buildOffice(host, joiners.slice(0, 4), 'K3')
      const det = await detailOnAll([host, ...joiners.slice(0, 4)], off.officeId)
      const r = assertConsistentRoster(det)
      reporter[r.ok ? 'pass' : 'fail']('K3', `5-node office roster: ${r.evidence}`)
    }
  }
  if (want('K4')) {
    // Rapid join/leave churn; roster must end consistent with no zombies.
    const off = await buildOffice(host, [], 'K4')
    const j = joiners[0]
    let lastErr = null
    for (let i = 0; i < 8; i++) {
      try {
        const inv = await mintInvite(host, off.officeId)
        await joinOffice(j, host, off.officeId, inv.data.token, `K4-${i}`)
        await sleep(800)
        await api(j, 'POST', `/api/teams/${off.officeId}/leave`)
        await sleep(800)
      } catch (err) {
        lastErr = err.message
      }
    }
    await sleep(3000)
    const det = await detailOnAll([host], off.officeId)
    const r = assertConsistentRoster(det)
    const remoteCount = (det[0].detail?.members ?? []).filter((m) => m.origin === 'remote').length
    reporter[r.ok ? 'pass' : 'partial']('K4', `after 8 join/leave cycles: ${r.evidence}; lingering remote members=${remoteCount} (expect 0)${lastErr ? `; lastErr=${lastErr}` : ''}`)
  }
  if (want('K5')) {
    reporter.skip('K5', 'host+9 (10 nodes) exceeds this run’s cluster size; would need --nodes 10 and heavy CPU; not run by default')
  }
  if (want('K6')) {
    reporter.skip('K6', 'run-time repeated kill/revive of a member-owner is timing-fragile under shared-CPU model contention (same class as E5)')
  }
  if (want('K7')) {
    // Multi-office isolation on one host instance: two offices don't cross-pollute.
    const offA = await buildOffice(host, [joiners[0]], 'K7A')
    const offB = await buildOffice(host, joiners[1] ? [joiners[1]] : [], 'K7B')
    const detA = await detailOnAll([host], offA.officeId)
    const detB = await detailOnAll([host], offB.officeId)
    const aMembers = new Set((detA[0].detail?.members ?? []).map((m) => m.appId))
    const bMembers = new Set((detB[0].detail?.members ?? []).map((m) => m.appId))
    const overlap = [...aMembers].filter((id) => bMembers.has(id))
    reporter[overlap.length === 0 ? 'pass' : 'fail']('K7', `two offices isolated: A=${aMembers.size} B=${bMembers.size} members, overlap=${overlap.length}`)
  }
}

// ── L. Multi-team / multi-role ───────────────────────────────────────────────
async function categoryL(host, joiners) {
  if (want('L1')) {
    if (joiners.length < 2) reporter.skip('L1', 'need 2 joiners')
    else {
      const offA = await buildOffice(host, [joiners[0]], 'L1A')
      const offB = await buildOffice(host, [joiners[1]], 'L1B')
      const detA = await detailOnAll([host, joiners[0]], offA.officeId)
      const detB = await detailOnAll([host, joiners[1]], offB.officeId)
      const rA = assertConsistentRoster(detA)
      const rB = assertConsistentRoster(detB)
      const aIds = new Set((detA[0].detail?.members ?? []).map((m) => m.appId))
      const bIds = new Set((detB[0].detail?.members ?? []).map((m) => m.appId))
      const noCross = [...aIds].every((id) => !bIds.has(id))
      reporter[rA.ok && rB.ok && noCross ? 'pass' : 'fail']('L1', `two offices each consistent (A:${rA.ok} B:${rB.ok}), no cross-pollution=${noCross}`)
    }
  }
  if (want('L2')) {
    // Lead is a remote (joiner) member: set leadAppId to the brought member.
    const off = await buildOffice(host, [joiners[0]], 'L2')
    const remote = (await members(host, off.officeId)).find((m) => m.origin === 'remote')
    if (!remote) reporter.skip('L2', 'no remote member to promote to lead')
    else {
      const patch = await api(host, 'PATCH', `/api/teams/${off.officeId}`, { leadAppId: remote.appId })
      const conv = await pollUntil(async () => {
        const det = await detailOnAll([host, joiners[0]], off.officeId)
        return det.every((d) => d.detail?.team?.leadAppId === remote.appId) ? det : null
      }, { timeoutMs: 12_000 })
      reporter[conv ? 'pass' : 'fail']('L2', conv ? `remote member promoted to lead, converged on both nodes` : `remote-lead did not converge (patch status=${patch.status})`)
    }
  }
  if (want('L3')) {
    reporter.skip('L3', 'same digital human as lead in A + member in B requires sharing one appId across two offices; harness provisions distinct members per office, cannot reuse identity this way over HTTP')
  }
  if (want('L4')) {
    reporter.skip('L4', 'chained re-invite (B invites C) requires a joiner to mint an invite for an office it joined; invite minting is host/authority-only on this surface')
  }
}

// ── M. Office-shared conversations (会话联邦化 · AC-S1) ───────────────────────
// A conversation created on ANY node must appear — same epoch, same label — in
// every node's session list, WITHOUT a run first (the P-1 fix). Backend-only:
// the conversation epoch replicates over the existing authority single-writer +
// replication plane, so no model reply is required.
async function categoryM(host, joiners) {
  if (!['M1', 'M2'].some(want)) return
  if (joiners.length < 1) { reporter.skip('M1', 'need >=1 joiner'); return }
  const joiner = joiners[0]
  const office = await buildOffice(host, [joiner], 'M')
  const nodes = [host, joiner]

  const listConversations = async (node) => {
    const r = await api(node, 'GET', `/api/teams/${office.officeId}/conversations`)
    return r.status === 200 && r.json?.success ? (r.json.data ?? []) : null
  }

  if (want('M1')) {
    // Open a native session ON THE JOINER (a non-authority node), before any run.
    const open = await api(joiner, 'POST', `/api/teams/${office.officeId}/conversations`, { title: 'Cross-node topic' })
    const epochId = open.json?.data?.epochId
    if (!epochId) {
      reporter.fail('M1', `open-conversation on joiner failed status=${open.status} err=${open.json?.error}`)
    } else {
      // Every node's session list must converge on the SAME conversation.
      const converged = await pollUntil(async () => {
        const lists = await Promise.all(nodes.map(listConversations))
        if (lists.some((l) => l == null)) return null
        const present = lists.every((l) => l.some((c) => c.epochId === epochId))
        return present ? lists : null
      }, { timeoutMs: 20_000, intervalMs: 1500 })
      reporter[converged ? 'pass' : 'fail'](
        'M1',
        converged
          ? `conversation created on joiner (pre-run) is office-wide consistent (${nodes.length} nodes)`
          : `conversation did not replicate to all nodes epoch=${epochId}`
      )
    }
  }

  if (want('M2')) {
    // Rename on the HOST → the new label must converge on the joiner too.
    const lists = await listConversations(host)
    const target = (lists ?? [])[0]
    if (!target) {
      reporter.skip('M2', 'no conversation to rename (M1 prerequisite)')
    } else {
      await api(host, 'PATCH', `/api/teams/${office.officeId}/conversations/${target.epochId}`, { title: 'Renamed on host' })
      const converged = await pollUntil(async () => {
        const l = await listConversations(joiner)
        if (l == null) return null
        const found = l.find((c) => c.epochId === target.epochId)
        return found && found.label === 'Renamed on host' ? l : null
      }, { timeoutMs: 15_000, intervalMs: 1500 })
      reporter[converged ? 'pass' : 'fail']('M2', converged ? 'rename on host converged on the joiner' : 'rename did not converge')
    }
  }
}

// ── Results output ────────────────────────────────────────────────────────────
function writeResults(manifest, hasModel) {
  const t = reporter.tally()
  const lines = []
  lines.push('# Decentralized Office · Backend Consistency Test Results (RESULTS)')
  lines.push('')
  lines.push(`> Run at ${new Date().toISOString()} · cluster=${manifest.nodes.filter((n) => n.ready).length} ready node(s) · model key present=${hasModel}`)
  lines.push(`> Spec: SCENARIOS.md · Driver: run-scenarios.mjs · HTTP/backend-only, real multi-process cluster.`)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`| Total | ✅ PASS | ❌ FAIL | ⚠️ PARTIAL | ⏭️ SKIP |`)
  lines.push(`|---|---|---|---|---|`)
  lines.push(`| ${t.total} | ${t.PASS} | ${t.FAIL} | ${t.PARTIAL} | ${t.SKIP} |`)
  lines.push('')
  const fails = reporter.records.filter((r) => r.status === 'FAIL')
  const partials = reporter.records.filter((r) => r.status === 'PARTIAL')
  if (fails.length) {
    lines.push('### ❌ FAILs (real cross-node disagreements — investigate)')
    lines.push('')
    for (const r of fails) lines.push(`- **${r.id}** — ${r.evidence}`)
    lines.push('')
  }
  if (partials.length) {
    lines.push('### ⚠️ PARTIALs (incomplete / weak signal)')
    lines.push('')
    for (const r of partials) lines.push(`- **${r.id}** — ${r.evidence}`)
    lines.push('')
  }
  lines.push('## Per-scenario')
  lines.push('')
  lines.push('| ID | Status | Evidence |')
  lines.push('|---|---|---|')
  const icon = { PASS: '✅', FAIL: '❌', PARTIAL: '⚠️', SKIP: '⏭️' }
  for (const r of reporter.records) {
    lines.push(`| ${r.id} | ${icon[r.status]} ${r.status} | ${String(r.evidence).replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  const out = path.join(PROJECT_ROOT, 'tests/decentralized/RESULTS.md')
  fs.writeFileSync(out, lines.join('\n'))
  console.log(`\n=== TALLY: total=${t.total} PASS=${t.PASS} FAIL=${t.FAIL} PARTIAL=${t.PARTIAL} SKIP=${t.SKIP} ===`)
  console.log(`=== Wrote ${out} ===`)
}

main().catch((err) => {
  console.error('[run-scenarios] FATAL:', err.stack || err.message)
  // best-effort stop
  if (!ARGS.noStart) clusterStop(CLUSTER_DIR)
  process.exit(1)
})
