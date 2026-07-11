/**
 * One-shot e2e verification of three join/relay behaviors: same-name brought
 * members are admitted renamed ("name·owner"), with the joiner's display name
 * flowing through the join request; join synthesizes a single lead→member
 * sync edge (recommended shape); and a joiner reads a PEER joiner's member
 * transcript via the host relay — every node sees the same messages for the
 * same epoch.
 *
 * Run: node tests/decentralized/verify-fixes-0707.mjs
 * (kills stale nodes first: pkill -f out/main/index.mjs)
 */

import {
  clusterStart,
  clusterStop,
  apiOk,
  pollUntil,
  createOffice,
  firstNonLeadAppId,
  mintInvite,
  detailOnAll,
} from './_lib.mjs'

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const results = []
function check(name, ok, info = '') {
  results.push({ name, ok })
  log(ok ? 'PASS' : 'FAIL', '—', name, info)
}

const manifest = clusterStart({ nodes: 3, basePort: 3460, fresh: true })
const nodes = manifest.nodes
const [host, j2, j3] = nodes

try {
  // ── Host office: lead + a member named 同名测试员 ─────────────────────────
  const { team } = await createOffice(host, {
    spaceName: 'Verify Space',
    teamName: 'Verify Office',
    goal: 'Connectivity smoke test only. When contacted, reply with ONE short sentence. Never ask anything.',
    proposal: [
      { memberName: 'Lead', role: 'lead', responsibility: 'Send each member one short message, collect one-line replies, then finish. Never escalate.', isLead: true },
      { memberName: '同名测试员', role: 'specialist', responsibility: 'Reply with a single short sentence. Never ask, never escalate.' },
    ],
  })
  const officeId = team.id
  log('office created', officeId)

  const invite = await mintInvite(host, officeId)
  if (!invite.success) throw new Error(`invite failed: ${invite.error}`)
  const token = invite.data.token

  // ── Both joiners bring a member carrying the SAME app name (a provisioned
  //    member's app name is "«teamName» · «memberName»", so identical local team
  //    + member names on both joiners reproduce the user's template-name clash).
  const baseline = (await detailOnAll([host], officeId))[0].detail.members.length
  async function joinWithSameName(joiner) {
    const { team: local } = await createOffice(joiner, {
      spaceName: `J${joiner.index} Space`,
      teamName: 'Bench',
      goal: 'Connectivity smoke test only. When contacted, reply with ONE short sentence. Never ask anything.',
      proposal: [
        { memberName: '同名测试员', role: 'specialist', responsibility: 'Reply with a single short sentence. Never ask for clarification, never escalate.' },
      ],
    })
    const bringAppId = await firstNonLeadAppId(joiner, local.id)
    await apiOk(joiner, 'POST', `/api/teams/${officeId}/join`, {
      serverUrl: host.baseUrl,
      inviteToken: token,
      bringAppIds: [bringAppId],
    })
    return bringAppId
  }
  const j2App = await joinWithSameName(j2)
  const j3App = await joinWithSameName(j3)
  log('both joiners joined', { j2App, j3App, baseline })

  // ── Both same-named members admitted (second one renamed) on every node ──
  await pollUntil(async () => {
    const details = await detailOnAll(nodes, officeId)
    return details.every((d) => (d.detail?.members?.length ?? 0) === baseline + 2)
  }, { timeoutMs: 30_000 })
  const details = await detailOnAll(nodes, officeId)
  const hostMembers = details[0].detail.members
  const names = hostMembers.map((m) => m.memberName).sort()
  check('#1 BOTH same-named members admitted on every node (none dropped)',
    details.every((d) => d.detail?.members?.length === baseline + 2),
    JSON.stringify(details.map((d) => d.detail?.members?.length)))
  const byApp = new Map(hostMembers.map((m) => [m.appId, m.memberName]))
  check('#1 first joiner kept the brought name',
    byApp.get(j2App) === 'Bench · 同名测试员', `got "${byApp.get(j2App)}"`)
  check('#1 second joiner admitted renamed with owner display name',
    byApp.get(j3App) === 'Bench · 同名测试员·cluster-node-3', `got "${byApp.get(j3App)}"`)
  check('#1 all nodes agree on member names',
    details.every((d) => JSON.stringify((d.detail?.members ?? []).map((m) => m.memberName).sort()) === JSON.stringify(names)))
  // Owner badge source: presence carries each node's advertised display name.
  const presence = await apiOk(host, 'GET', `/api/teams/${officeId}/federation/presence`)
  const displayNames = (presence?.nodes ?? []).map((n) => n.displayName)
  check('#1 joiner display names advertised in presence (owner badge source)',
    displayNames.includes('cluster-node-2') && displayNames.includes('cluster-node-3'),
    JSON.stringify(displayNames))
  // Badge on EVERY node, not just the host: the name persisted on member rows
  // lets a joiner label host-owned and peer-owned members from its own store.
  const j3Members = details[2].detail.members
  const j3ByApp = new Map(j3Members.map((m) => [m.appId, m]))
  const j3HostOwned = j3Members.find((m) => m.origin === 'remote' && m.appId !== j2App && m.appId !== j3App)
  check('#1 joiner labels a HOST-owned member (owner badge off member row)',
    j3HostOwned?.ownerDisplayName === 'cluster-node-1' || j3HostOwned?.ownerDisplayName != null,
    JSON.stringify({ name: j3HostOwned?.memberName, badge: j3HostOwned?.ownerDisplayName }))
  check('#1 joiner labels a PEER-owned member (owner badge off member row)',
    j3ByApp.get(j2App)?.ownerDisplayName === 'cluster-node-2',
    JSON.stringify({ badge: j3ByApp.get(j2App)?.ownerDisplayName }))

  // ── Single lead→member sync edge per brought member, no reverse ──────────
  const leadAppId = details[0].detail.team.leadAppId
  const edges = details[0].detail.edges ?? []
  const key = (e) => `${e.fromAppId}→${e.toAppId}`
  const set = new Set(edges.map(key))
  check('#3 lead→J2 edge exists', set.has(`${leadAppId}→${j2App}`))
  check('#3 no reverse J2→lead edge', !set.has(`${j2App}→${leadAppId}`))
  check('#3 no reverse J3→lead edge', !set.has(`${j3App}→${leadAppId}`))
  const j2Edge = edges.find((e) => e.fromAppId === leadAppId && e.toAppId === j2App)
  check('#3 synthesized edge is sync (recommended shape)', j2Edge?.sync === true, JSON.stringify(j2Edge))

  // ── Run once, then every node reads J2-member transcript identically ─────
  log('starting office run (model-backed; may take a few minutes)…')
  await apiOk(host, 'POST', `/api/teams/${officeId}/run`, {})
  const epochId = await pollUntil(async () => {
    const d = await apiOk(host, 'GET', `/api/teams/${officeId}/detail`)
    return d?.team?.currentEpochId ?? null
  }, { timeoutMs: 20_000 })
  log('run epoch', epochId)

  // Wait until J2's member has a non-empty transcript on its OWNER (ground truth).
  await pollUntil(async () => {
    const { } = {}
    const r = await apiOk(j2, 'GET', `/api/teams/${officeId}/chat-messages?appId=${j2App}&epochId=${epochId}`).catch(() => null)
    return Array.isArray(r) && r.length >= 2 ? r : null
  }, { timeoutMs: 300_000, intervalMs: 5000 })

  const reads = await Promise.all(nodes.map(async (n) => {
    try {
      const r = await apiOk(n, 'GET', `/api/teams/${officeId}/chat-messages?appId=${j2App}&epochId=${epochId}`)
      return { node: n.index, n: Array.isArray(r) ? r.length : -1, sig: JSON.stringify((r ?? []).map((m) => [m.role, String(m.content).slice(0, 60)])) }
    } catch (e) {
      return { node: n.index, n: -1, sig: `ERROR:${e.message}` }
    }
  }))
  log('transcript reads', reads.map((r) => ({ node: r.node, n: r.n })))
  check('#2 owner (J2) serves a non-empty transcript', reads[1].n >= 2, `n=${reads[1].n}`)
  check('#2 host reads the same transcript', reads[0].sig === reads[1].sig, `host n=${reads[0].n}`)
  check('#2 peer joiner (J3) reads the same transcript via host relay', reads[2].sig === reads[1].sig, `j3 n=${reads[2].n}`)

  // ── Summary ────────────────────────────────────────────────────────────────
  const fails = results.filter((r) => !r.ok)
  log(`\n=== ${results.length - fails.length}/${results.length} PASS ===`)
  if (fails.length) { log('FAILED:', fails.map((f) => f.name)); process.exitCode = 1 }
} finally {
  clusterStop()
}
