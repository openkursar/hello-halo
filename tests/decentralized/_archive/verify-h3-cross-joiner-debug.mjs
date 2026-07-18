/**
 * One-shot H3 diagnosis: host + 2 joiners, joiner-A dispatches a 1:1 message to
 * joiner-B's member, then every node's transcript view is dumped each poll so
 * the failing hop (send → relay wake → owner turn → reply → read consistency)
 * is visible directly instead of through lossy node logs.
 *
 * Run:  npm run build && node tests/decentralized/_archive/verify-h3-cross-joiner-debug.mjs
 */
import {
  clusterStart,
  clusterStop,
  api,
  createOffice,
  mintInvite,
  joinOffice,
  members,
  chatOnAll,
  sleep,
} from '../_lib.mjs'

const CLUSTER_DIR = '.cluster-h3dbg'
const manifest = clusterStart({ nodes: 3, basePort: 3700, clusterDir: CLUSTER_DIR })
const nodes = manifest.nodes ?? manifest
const [host, jA, jB] = nodes
try {
  const { team } = await createOffice(host, {
    spaceName: 'h3dbg',
    teamName: 'h3dbg',
    goal: 'debug',
    proposal: [{ memberName: 'Lead', role: 'lead', responsibility: 'r' }],
  })
  const officeId = team.id
  const inv = await mintInvite(host, officeId)
  const a = await joinOffice(jA, host, officeId, inv.data.token, 'A')
  const b = await joinOffice(jB, host, officeId, inv.data.token, 'B')
  console.log('joined: A bring=', a.bringAppId, 'B bring=', b.bringAppId)
  await sleep(4000)

  // The dispatch surface requires an open run epoch (mirrors the H suite).
  const run = await api(host, 'POST', `/api/teams/${officeId}/run`)
  console.log('run status=', run.status)
  await sleep(2000)

  const hostMs = await members(host, officeId)
  console.log('host roster:', hostMs.map((m) => `${m.memberName}/${m.origin}/${m.appId.slice(0, 8)}`))
  const targetB = hostMs.find((m) => m.appId === b.bringAppId)
  if (!targetB) throw new Error('joiner-B member not on host roster')

  const send = await api(jA, 'POST', `/api/teams/${officeId}/members/${targetB.appId}/send`, {
    message: 'H3 debug: please reply briefly.',
  })
  console.log('send from A status=', send.status, JSON.stringify(send.json).slice(0, 300))

  for (let t = 5; t <= 95; t += 10) {
    await sleep(10_000)
    const chats = await chatOnAll(nodes, officeId, targetB.appId)
    console.log(
      `t+${t}s ` +
        chats
          .map((c) => `n${c.node.index}:${c.status}/len=${(c.messages ?? []).length}${c.error ? `/err=${c.error}` : ''}`)
          .join(' | ')
    )
    const lens = chats.map((c) => (c.messages ?? []).length)
    if (lens.every((l) => l >= 2 && l === lens[0])) {
      console.log('CONSISTENT REPLY REACHED')
      break
    }
  }
  const final = await chatOnAll(nodes, officeId, targetB.appId)
  for (const c of final) {
    console.log(
      `node-${c.node.index} transcript:`,
      JSON.stringify((c.messages ?? []).map((m) => ({ seq: m.seq, role: m.role, c: String(m.content).slice(0, 60) })))
    )
  }
} finally {
  clusterStop(CLUSTER_DIR)
}
