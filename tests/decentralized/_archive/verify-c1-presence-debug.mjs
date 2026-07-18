/**
 * One-shot C1 diagnosis: boot host+joiner, build an office, SIGKILL the joiner,
 * then (a) verify the joiner's HTTP truly stops answering (kill efficacy) and
 * (b) poll the host's federation presence for the suspect/offline transition,
 * dumping the raw presence payload each poll so the failing layer is visible.
 *
 * Run:  npm run build && node tests/decentralized/_archive/verify-c1-presence-debug.mjs
 */
import {
  clusterStart,
  clusterStop,
  api,
  createOffice,
  mintInvite,
  joinOffice,
  killNode,
  sleep,
} from '../_lib.mjs'

const CLUSTER_DIR = '.cluster-c1dbg'
const manifest = clusterStart({ nodes: 2, basePort: 3600, clusterDir: CLUSTER_DIR })
const nodes = manifest.nodes ?? manifest
const [host, joiner] = nodes
try {
  const { team } = await createOffice(host, {
    spaceName: 'c1dbg',
    teamName: 'c1dbg',
    goal: 'debug',
    proposal: [
      { memberName: 'Lead', role: 'lead', responsibility: 'r' },
      { memberName: 'M2', role: 'analyst', responsibility: 'r' },
    ],
  })
  const officeId = team.id
  const inv = await mintInvite(host, officeId)
  await joinOffice(joiner, host, officeId, inv.data.token, 'dbg')
  await sleep(4000)

  const pres0 = await api(host, 'GET', `/api/teams/${officeId}/federation/presence`)
  console.log('presence before kill:', JSON.stringify(pres0.json))

  console.log('killing joiner pid', joiner.pid, 'killed=', killNode(joiner))
  for (let t = 3; t <= 27; t += 3) {
    await sleep(3000)
    const alive = await api(joiner, 'GET', '/api/teams')
    const pres = await api(host, 'GET', `/api/teams/${officeId}/federation/presence`)
    const nodesArr = pres.json?.data?.nodes ?? []
    console.log(
      `t+${t}s joinerHttp=${alive.status} presence=` +
        JSON.stringify(nodesArr.map((n) => ({ id: String(n.nodeId ?? n.identity ?? '').slice(0, 14), st: n.status })))
    )
  }
} finally {
  clusterStop(CLUSTER_DIR)
}
