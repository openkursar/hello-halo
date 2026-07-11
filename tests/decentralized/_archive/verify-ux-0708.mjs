/**
 * One-shot e2e verification of three UX behaviors: a JOINER-owned member's
 * in-flight turn reads 'working' in the roster on the HOST and on a PEER
 * viewer (remote-busy overlay); a human 1:1 send arrives verbatim (no "[Team
 * message from Lead]" header); and a dead joiner is visible as offline on
 * ANOTHER JOINER (adopted peer presence), not only on the host.
 *
 * Run: node tests/decentralized/verify-ux-0708.mjs
 * (kills stale nodes first: pkill -f out/main/index.mjs)
 */

import {
  clusterStart,
  clusterStop,
  api,
  apiOk,
  pollUntil,
  createOffice,
  firstNonLeadAppId,
  mintInvite,
  killNode,
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
  const { team } = await createOffice(host, {
    spaceName: 'UX Space',
    teamName: 'UX Office',
    goal: 'Connectivity smoke test only. Send each member ONE short message and collect their one-line replies, then finish. Never ask the user anything.',
    proposal: [
      { memberName: 'Alpha', role: 'specialist', responsibility: 'Reply with a single short sentence. Never ask for clarification, never escalate.' },
    ],
  })
  const officeId = team.id
  const invite = await mintInvite(host, officeId)
  if (!invite.success) throw new Error(`invite failed: ${invite.error}`)

  async function join(joiner, memberName) {
    const { team: local } = await createOffice(joiner, {
      spaceName: `J${joiner.index} Space`,
      teamName: `J${joiner.index} Bench`,
      goal: 'Connectivity smoke test only. When contacted, reply with ONE short sentence. Never ask anything.',
      proposal: [
        { memberName, role: 'specialist', responsibility: 'Reply with a single short sentence. Never ask for clarification, never escalate.' },
      ],
    })
    const bringAppId = await firstNonLeadAppId(joiner, local.id)
    await apiOk(joiner, 'POST', `/api/teams/${officeId}/join`, {
      serverUrl: host.baseUrl,
      inviteToken: invite.data.token,
      bringAppIds: [bringAppId],
    })
    return bringAppId
  }
  const j2App = await join(j2, 'Bravo')
  const j3App = await join(j3, 'Charlie')
  log('joined', { j2App, j3App })

  // ── Run, and watch the JOINER-owned member pulse on host + peer viewer ────
  await apiOk(host, 'POST', `/api/teams/${officeId}/run`, {})
  let hostSawWorking = false
  let peerSawWorking = false
  const runStart = Date.now()
  while (Date.now() - runStart < 300_000) {
    const [h, p] = await Promise.all([
      apiOk(host, 'GET', `/api/teams/${officeId}/detail`).catch(() => null),
      apiOk(j3, 'GET', `/api/teams/${officeId}/detail`).catch(() => null),
    ])
    const statusOf = (d) => d?.roster?.find?.((m) => m.appId === j2App)?.status
    if (statusOf(h) === 'working') hostSawWorking = true
    if (statusOf(p) === 'working') peerSawWorking = true
    if (h?.team?.status && h.team.status !== 'running' && Date.now() - runStart > 15_000) break
    if (hostSawWorking && peerSawWorking && h?.team?.status !== 'running') break
    await new Promise((r) => setTimeout(r, 1000))
  }
  check('#5 host roster pulsed the JOINER-owned member as working', hostSawWorking)
  check('#5 peer viewer (J3) roster pulsed it too', peerSawWorking)

  // ── Human 1:1 send from a PEER viewer arrives verbatim ────────────────────
  const probe = 'PING-RAW-42 你好'
  const sendRes = await api(j3, 'POST', `/api/teams/${officeId}/members/${j2App}/send`, { message: probe })
  check('#3 human 1:1 send from a viewer succeeds', sendRes.json?.success === true, JSON.stringify(sendRes.json)?.slice(0, 120))
  const epochId = (await apiOk(host, 'GET', `/api/teams/${officeId}/epochs`))[0]?.id
  const transcript = await pollUntil(async () => {
    const r = await apiOk(j3, 'GET', `/api/teams/${officeId}/chat-messages?appId=${j2App}&epochId=${epochId}`).catch(() => null)
    return Array.isArray(r) && r.some((m) => String(m.content).includes('PING-RAW-42')) ? r : null
  }, { timeoutMs: 60_000, intervalMs: 3000 })
  const probeMsg = transcript.find((m) => String(m.content).includes('PING-RAW-42'))
  check('#3 the member received the person’s words verbatim',
    probeMsg?.content === probe, JSON.stringify(probeMsg?.content)?.slice(0, 120))
  check('#3 no impersonated "[Team message from …]" header on it',
    !String(probeMsg?.content).includes('[Team message from'))

  // ── Kill J2; its offline state must be visible on J3 (a peer joiner) ─────
  killNode(j2)
  log('killed node-2; waiting for confirmed-offline (~13s)…')
  const j3Presence = await pollUntil(async () => {
    const r = await apiOk(j3, 'GET', `/api/teams/${officeId}/federation/presence`).catch(() => null)
    const row = r?.nodes?.find((n) => n.identity === j2.identityId || n.nodeId === j2.identityId)
    return row && row.status !== 'online' ? r : null
  }, { timeoutMs: 40_000, intervalMs: 2000 })
  const j2RowOnJ3 = j3Presence.nodes.find((n) => n.nodeId === j2.identityId)
  check('#4 peer joiner (J3) sees node-2 away/offline (adopted presence)',
    j2RowOnJ3?.status === 'offline' || j2RowOnJ3?.status === 'suspect', JSON.stringify(j2RowOnJ3))
  const hostPresence = await apiOk(host, 'GET', `/api/teams/${officeId}/federation/presence`)
  const j2RowOnHost = hostPresence.nodes.find((n) => n.nodeId === j2.identityId)
  check('#4 host sees node-2 away/offline',
    j2RowOnHost?.status === 'offline' || j2RowOnHost?.status === 'suspect', JSON.stringify(j2RowOnHost))

  const fails = results.filter((r) => !r.ok)
  log(`\n=== ${results.length - fails.length}/${results.length} PASS ===`)
  if (fails.length) { log('FAILED:', fails.map((f) => f.name)); process.exitCode = 1 }
} finally {
  clusterStop()
}
