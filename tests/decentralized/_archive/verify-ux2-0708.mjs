/**
 * One-shot e2e verification of two status-sync behaviors:
 *   A. pulse stops everywhere: after the run rests, NO member keeps 'working'
 *      on a peer viewer (per-turn status flips push a roster refresh);
 *   B. a member whose owner dies mid-turn drops back from 'working' once the
 *      owner is confirmed offline (remote-busy ledger cleared), instead of
 *      pulsing for the full busy TTL.
 *
 * Run: node tests/decentralized/verify-ux2-0708.mjs
 */

import {
  clusterStart,
  clusterStop,
  apiOk,
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const manifest = clusterStart({ nodes: 3, basePort: 3460, fresh: true })
const nodes = manifest.nodes
const [host, j2, j3] = nodes

try {
  const { team } = await createOffice(host, {
    spaceName: 'UX2 Space',
    teamName: 'UX2 Office',
    goal: 'Connectivity smoke test only. Send each member ONE short message and collect their one-line replies, then call team_complete. Never ask the user anything.',
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

  const statusOf = (d, appId) => d?.roster?.find?.((m) => m.appId === appId)?.status

  // ── B: kill the owner while its member's turn is in flight ────────────────
  await apiOk(host, 'POST', `/api/teams/${officeId}/run`, {})
  let killed = false
  const t0 = Date.now()
  while (Date.now() - t0 < 240_000 && !killed) {
    const h = await apiOk(host, 'GET', `/api/teams/${officeId}/detail`).catch(() => null)
    if (statusOf(h, j2App) === 'working') {
      killNode(j2)
      killed = true
      log('killed node-2 while its member was mid-turn')
      break
    }
    if (h?.team?.status && h.team.status !== 'running' && Date.now() - t0 > 20_000) break
    await sleep(800)
  }
  check('B setup: owner killed while its member pulsed working', killed)

  if (killed) {
    let clearedAt = null
    const k0 = Date.now()
    while (Date.now() - k0 < 45_000) {
      const [h, p] = await Promise.all([
        apiOk(host, 'GET', `/api/teams/${officeId}/detail`).catch(() => null),
        apiOk(j3, 'GET', `/api/teams/${officeId}/detail`).catch(() => null),
      ])
      if (statusOf(h, j2App) !== 'working' && statusOf(p, j2App) !== 'working') {
        clearedAt = Date.now() - k0
        break
      }
      await sleep(1500)
    }
    check('B: dead member stopped pulsing on host AND peer within 45s (not busy-TTL 10min)',
      clearedAt !== null, `cleared after ${clearedAt}ms`)
  }

  // ── A: once the run rests, nobody keeps spinning on the peer viewer ───────
  const r0 = Date.now()
  let rested = false
  while (Date.now() - r0 < 300_000) {
    const h = await apiOk(host, 'GET', `/api/teams/${officeId}/detail`).catch(() => null)
    if (h?.team?.status && h.team.status !== 'running' && h.team.status !== 'waiting_user') { rested = true; break }
    await sleep(2000)
  }
  check('A setup: the run rested on the host', rested)
  if (rested) {
    // Give the final coalesced roster push a moment, then read the peer viewer.
    await sleep(4000)
    const p = await apiOk(j3, 'GET', `/api/teams/${officeId}/detail`).catch(() => null)
    const spinning = (p?.roster ?? []).filter((m) => m.status === 'working').map((m) => m.memberName)
    check('A: no member keeps "working" on the peer viewer after the run rested',
      spinning.length === 0, JSON.stringify(spinning))
    check('A: peer viewer run banner rested too',
      p?.team?.status !== 'running', String(p?.team?.status))
  }

  const fails = results.filter((r) => !r.ok)
  log(`\n=== ${results.length - fails.length}/${results.length} PASS ===`)
  if (fails.length) { log('FAILED:', fails.map((f) => f.name)); process.exitCode = 1 }
} finally {
  clusterStop()
}
