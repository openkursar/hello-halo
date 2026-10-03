/**
 * Federation at scale: one host + 30 joiners (31 real nodes, one office).
 *
 * The property under test is that a joiner's inbound traffic grows with what it
 * owns and shows, plus a board/feed digest, and not with the size of the office.
 * Each joiner's link health line reports what it received by plane
 * (`rx=control:<frames>/<KB>,stream:…,feed:…,artifact:…`, once a minute), and
 * this suite reads those lines from every node's log.
 *
 *   S1  every joiner is admitted and sees the full roster (31 members).
 *   S2  roster/run-state churn on the host reaches each joiner as run-state
 *       deltas: its control-plane growth per churn round stays under a fixed
 *       per-round budget that does not scale with N.
 *   S3  [model] every member speaks once. A joiner that shows no panel receives
 *       no stream frames. Its feed-plane inbound stays under own + digest,
 *       against the legacy "every transcript everywhere" volume that is
 *       reported next to it.
 *
 * Bounds (REPORT §3.5): per-joiner inbound ≤ k·(own + open + digest). Here
 * open = 0, own = the joiner's own transcript (which it publishes, not
 * receives), and digest = one feed-digest per re-announce. The constants below
 * are the k for each plane and are stated in the output.
 *
 * Heavy: 31 Electron processes. Run it alone after `npm run build`:
 *   node tests/decentralized/run.mjs scale
 */

import fs from 'node:fs'
import { clusterStart, clusterStop, apiOk, api, pollUntil, sleep, Reporter, createOffice, mintInvite, joinOffice, members } from './_lib.mjs'

const CLUSTER_DIR = '.cluster-scale'
const JOINERS = 30
const HEALTH_LINE_WAIT_MS = 75_000
/**
 * S2 budget, from the measured composition of a churn round (calibration run:
 * a replicated epoch row ≈ 0.8 KB and a run-state status ≈ 0.1 KB per round;
 * host heartbeats ≈ 5 KB/min regardless), with headroom. Nothing in it grows
 * with the office: a full roster (≈ 18 KB at 31 members) goes out only on a
 * membership change, and S2 changes none.
 */
const CONTROL_KB_PER_ROUND = 1.5
const CONTROL_KB_PER_MINUTE_IDLE = 6
/**
 * S3: a digest entry is ≈ 200 B (session feed key + seq). A joiner hears each
 * growth of a feed at most once, in the next delta digest, so the digest volume
 * is bounded by the number of transcript messages written in the office.
 */
const DIGEST_KB_PER_MESSAGE = 0.25

const report = new Reporter()
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

function parseCounts(field) {
  const out = {}
  if (!field) return out
  for (const part of field.split(',')) {
    const sep = part.lastIndexOf(':')
    const [frames, kb] = part.slice(sep + 1).split('/').map(Number)
    out[part.slice(0, sep)] = { frames, kb }
  }
  return out
}

/**
 * Last reading of a node's joined-office health line: inbound by plane
 * (`rx=`) and by frame kind (`rxKinds=`), each { name: { frames, kb } }.
 */
function readRx(node, officeId) {
  const text = fs.readFileSync(node.logFile, 'utf8')
  const lines = text.split('\n').filter((l) => l.includes(`health office=${officeId} role=joined`) && l.includes(' rx='))
  const last = lines.at(-1)
  if (!last) return null
  const field = (name) => last.split(` ${name}=`)[1]?.split(' ')[0]
  const [h, m, sec] = (last.match(/(\d\d):(\d\d):(\d\d(?:\.\d+)?)/) ?? []).slice(1).map(Number)
  return { ...parseCounts(field('rx')), kinds: parseCounts(field('rxKinds')), atSec: h * 3600 + m * 60 + sec }
}

function kindGrowth(before, after, kind) {
  return {
    frames: (after.kinds[kind]?.frames ?? 0) - (before.kinds[kind]?.frames ?? 0),
    kb: (after.kinds[kind]?.kb ?? 0) - (before.kinds[kind]?.kb ?? 0),
  }
}

/** What a joiner received between two readings, by kind, largest first — the composition behind a bound. */
function kindDelta(before, after) {
  return Object.entries(after.kinds)
    .map(([kind, r]) => [kind, r.frames - (before.kinds[kind]?.frames ?? 0), r.kb - (before.kinds[kind]?.kb ?? 0)])
    .filter(([, frames]) => frames > 0)
    .sort((a, b) => b[2] - a[2])
    .map(([kind, frames, kb]) => `${kind}:${frames}/${kb}KB`)
    .join(' ')
}

const manifest = clusterStart({ nodes: JOINERS + 1, basePort: 3960, fresh: true, clusterDir: CLUSTER_DIR })
const [host, ...joiners] = manifest.nodes
const hasModel = !!manifest.model?.hasKey

try {
  const { team } = await createOffice(host, {
    spaceName: 'Scale Office Space',
    teamName: 'Scale Office',
    goal: 'Scale test. When contacted, reply with ONE short sentence. Never ask anything.',
    proposal: [{ memberName: 'Host Specialist', role: 'specialist', responsibility: 'Reply with one short sentence.' }],
  })
  const officeId = team.id

  await report.run('S1', async (mark) => {
    for (const joiner of joiners) {
      const invite = await mintInvite(host, officeId)
      if (!invite?.success) throw new Error(`invite for node-${joiner.index}: ${invite?.error}`)
      await joinOffice(joiner, host, officeId, invite.data.token, 'scale')
    }
    const expected = JOINERS + 2 // host lead + host specialist + one per joiner
    const settled = await pollUntil(async () => {
      const counts = await Promise.all(joiners.map(async (j) => (await members(j, officeId)).length))
      return counts.every((n) => n >= expected) ? counts : null
    }, { timeoutMs: 180_000, intervalMs: 5000 })
    mark(settled ? 'PASS' : 'FAIL', settled ? `all ${JOINERS} joiners see ${expected} members` : 'roster did not converge on every joiner')
  })

  await report.run('S2', async (mark) => {
    await sleep(HEALTH_LINE_WAIT_MS)
    const before = joiners.map((j) => readRx(j, officeId))
    if (before.some((r) => !r)) return mark('FAIL', 'a joiner logged no rx health line (collector did not run)')
    const ROUNDS = 10
    for (let i = 0; i < ROUNDS; i++) {
      await apiOk(host, 'POST', `/api/teams/${officeId}/conversations`, { title: `churn ${i}` })
      await sleep(1500)
    }
    await sleep(HEALTH_LINE_WAIT_MS)
    const after = joiners.map((j) => readRx(j, officeId))
    // Each joiner's budget covers its own measurement window (health lines are a minute apart).
    const over = after.map((r, i) => {
      const minutes = Math.max(1, (r.atSec - before[i].atSec) / 60)
      const budget = ROUNDS * CONTROL_KB_PER_ROUND + minutes * CONTROL_KB_PER_MINUTE_IDLE
      return { growth: r.control.kb - before[i].control.kb, budget, minutes, rosters: kindGrowth(before[i], r, 'roster').frames }
    })
    const worst = over.reduce((a, b) => (b.growth - b.budget > a.growth - a.budget ? b : a))
    const worstAt = over.indexOf(worst)
    if (worst.growth <= 0) return mark('FAIL', 'no control-plane growth: the churn did not reach the joiners (precondition)')
    const fullRosters = Math.max(...over.map((o) => o.rosters))
    const ok = over.every((o) => o.growth <= o.budget) && fullRosters === 0
    mark(ok ? 'PASS' : 'FAIL',
      `control-plane growth per joiner over ${ROUNDS} rounds: worst ${worst.growth} KB vs budget ${Math.round(worst.budget)} KB ` +
      `(${CONTROL_KB_PER_ROUND} KB/round + ${CONTROL_KB_PER_MINUTE_IDLE} KB/min over ${worst.minutes.toFixed(1)} min, independent of N=${JOINERS + 1}); ` +
      `full rosters received: max ${fullRosters} (want 0: membership did not change); ` +
      `worst joiner received ${kindDelta(before[worstAt], after[worstAt])}`)
  })

  await report.run('S3', async (mark) => {
    if (!hasModel) return mark('SKIP', 'needs a model key (.env.local HALO_TEST_API_KEY)')
    const before = joiners.map((j) => readRx(j, officeId))
    // Every joiner's own member speaks once, driven on its own node.
    const brought = []
    for (const joiner of joiners) {
      const own = (await members(joiner, officeId)).find((m) => m.origin !== 'remote' && !m.isLead)
      if (!own) throw new Error(`node-${joiner.index}: its brought member is missing`)
      brought.push({ joiner, appId: own.appId })
      await api(joiner, 'POST', `/api/teams/${officeId}/members/${own.appId}/send`, { message: 'Say hello in one short sentence.' })
    }
    await sleep(120_000 + HEALTH_LINE_WAIT_MS)
    const after = joiners.map((j) => readRx(j, officeId))
    const streamFrames = after.map((r, i) => r.stream.frames - before[i].stream.frames)
    const feedKb = after.map((r, i) => r.feed.kb - before[i].feed.kb)
    // Legacy volume a joiner would have received: every member's transcript
    // (members message one another, so the host's members count too).
    let transcriptsKb = 0
    let messages = 0
    for (const member of await members(host, officeId)) {
      const res = await api(host, 'GET', `/api/teams/${officeId}/chat-messages?appId=${member.appId}`)
      const rows = res.json?.data ?? []
      transcriptsKb += JSON.stringify(rows).length / 1024
      messages += rows.length
    }
    const copied = after.map((r, i) => kindGrowth(before[i], r, 'feed.feed-entries').frames)
    const digestKb = after.map((r, i) => kindGrowth(before[i], r, 'feed.feed-digest').kb)
    const digestBudget = Math.ceil(messages * DIGEST_KB_PER_MESSAGE)
    const worstFeed = Math.max(...feedKb)
    const worstAt = feedKb.indexOf(worstFeed)
    const ok =
      streamFrames.every((n) => n === 0) &&
      copied.every((n) => n === 0) &&
      Math.max(...digestKb) <= digestBudget
    mark(ok ? 'PASS' : 'FAIL',
      `stream frames to non-viewing joiners: max ${Math.max(...streamFrames)} (want 0); ` +
      `other members' transcript batches copied: max ${Math.max(...copied)} (want 0); ` +
      `digest KB per joiner: max ${Math.max(...digestKb)} vs budget ${digestBudget} (${messages} messages × ${DIGEST_KB_PER_MESSAGE} KB); ` +
      `feed-plane KB per joiner (digests + acks of its own transcript): max ${worstFeed} ` +
      `vs legacy ≈ ${Math.round(transcriptsKb)} KB (every transcript on every node); ` +
      `worst joiner received ${kindDelta(before[worstAt], after[worstAt])}`)
  })
} finally {
  const t = report.tally()
  log(`Scale: ${t.PASS} pass, ${t.FAIL} fail, ${t.SKIP} skip of ${t.total}`)
  clusterStop(CLUSTER_DIR)
  process.exitCode = t.FAIL > 0 ? 1 : 0
}
