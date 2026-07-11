#!/usr/bin/env node
/**
 * Reference driver for a local multi-node federation cluster: reads the
 * manifest from launch-nodes.mjs and drives a full distributed office
 * lifecycle purely over HTTP (no UI) against the federation control-plane
 * routes — create office, mint invite, join, run, poll presence/detail.
 * Verbose LOG() output makes each step observable for an automated driver.
 *
 * Asserts: every join succeeds, presence converges to all N nodes, and the
 * host roster shows the joiners' remote-owned members.
 *
 * Usage: node scripts/cluster/demo-federation.mjs [--cluster DIR]
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')

const LOG = (...a) => console.log('[demo]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const next = argv[i + 1]
      args[key] = next && !next.startsWith('--') ? (i++, next) : true
    }
  }
  return args
}

function loadManifest(args) {
  const dir = path.resolve(PROJECT_ROOT, args.cluster || '.cluster')
  const file = path.join(dir, 'nodes.json')
  if (!fs.existsSync(file)) {
    console.error(`[demo] No manifest at ${file}. Run launch-nodes.mjs first.`)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

/** HTTP helper bound to one node; throws on transport or app-level failure. */
function client(node) {
  return async function call(method, apiPath, body) {
    const res = await fetch(`${node.baseUrl}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${node.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    let json
    try {
      json = await res.json()
    } catch {
      throw new Error(`node-${node.index} ${method} ${apiPath} → ${res.status} (non-JSON)`)
    }
    if (json.success === false) {
      throw new Error(`node-${node.index} ${method} ${apiPath} → ${json.error}`)
    }
    return json.data ?? json
  }
}

async function createOfficeMember(call, opts) {
  const space = await call('POST', '/api/spaces', { name: opts.spaceName, icon: '🏢' })
  const spaceId = space.id
  const team = await call('POST', '/api/teams', {
    input: {
      name: opts.teamName,
      goal: opts.goal,
      owningSpaceId: spaceId,
      memberSourcing: 'ai',
      collabMode: 'structured',
      escalationRouting: 'lead',
    },
    confirmedProposal: opts.proposal,
  })
  return { spaceId, team }
}

async function firstNonLeadMemberAppId(call, teamId) {
  const detail = await call('GET', `/api/teams/${teamId}/detail`)
  const members = detail.members ?? detail.team?.members ?? []
  const nonLead = members.find((m) => !m.isLead) ?? members[0]
  return nonLead?.appId ?? null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const manifest = loadManifest(args)
  const nodes = manifest.nodes.filter((n) => n.ready)
  if (nodes.length < 2) {
    console.error(`[demo] Need at least 2 ready nodes; got ${nodes.length}.`)
    process.exit(1)
  }
  const host = nodes[0]
  const joiners = nodes.slice(1)
  const hostCall = client(host)
  const serverUrl = `http://127.0.0.1:${host.port}` // loopback; client upgrades to ws + /ws

  LOG(`Host = node-${host.index} (${host.baseUrl}); joiners = ${joiners.map((j) => `node-${j.index}`).join(', ')}`)

  LOG('Host: creating office "Competitive Weekly"…')
  const { team } = await createOfficeMember(hostCall, {
    spaceName: 'Cluster Host Space',
    teamName: 'Competitive Weekly',
    goal: 'Produce a short competitive landscape note.',
    proposal: [{ memberName: 'Analyst', role: 'analyst', responsibility: 'Research and summarize competitors.' }],
  })
  const officeId = team.id
  LOG(`Host: office created officeId=${officeId}`)

  const invite = await hostCall('POST', `/api/teams/${officeId}/invite`, {})
  LOG(`Host: invite minted (token len=${invite.token?.length ?? 0})`)

  for (const joiner of joiners) {
    const call = client(joiner)
    LOG(`node-${joiner.index}: provisioning a local digital human…`)
    const { team: localTeam } = await createOfficeMember(call, {
      spaceName: `Cluster Joiner ${joiner.index} Space`,
      teamName: `Joiner ${joiner.index} Bench`,
      goal: 'Provide a specialist to a shared office.',
      proposal: [
        { memberName: `Specialist ${joiner.index}`, role: 'specialist', responsibility: 'Contribute domain expertise.' },
      ],
    })
    const bringAppId = await firstNonLeadMemberAppId(call, localTeam.id)
    if (!bringAppId) throw new Error(`node-${joiner.index}: no local member appId to bring`)

    LOG(`node-${joiner.index}: joining office ${officeId} bringing app ${bringAppId}…`)
    await call('POST', `/api/teams/${officeId}/join`, {
      serverUrl,
      inviteToken: invite.token,
      bringAppIds: [bringAppId],
    })
    LOG(`node-${joiner.index}: join request accepted`)
  }

  const expectedNodes = nodes.length
  LOG(`Host: waiting for presence to converge to ${expectedNodes} node(s)…`)
  let presence = null
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    presence = await hostCall('GET', `/api/teams/${officeId}/federation/presence`)
    const online = (presence?.nodes ?? []).filter((n) => n.status === 'online')
    LOG(`  presence: ${presence?.nodes?.length ?? 0} node(s), ${online.length} online (role=${presence?.role})`)
    if ((presence?.nodes?.length ?? 0) >= expectedNodes) break
    await sleep(1500)
  }

  const detail = await hostCall('GET', `/api/teams/${officeId}/detail`)
  const roster = (detail.members ?? []).map((m) => ({
    appId: m.appId,
    name: m.memberName,
    origin: m.origin ?? 'local',
    isLead: !!m.isLead,
  }))
  LOG('Host office roster:')
  for (const m of roster) LOG(`  - ${m.name} [${m.origin}]${m.isLead ? ' (lead)' : ''} ${m.appId}`)

  // Model-backed; does not block on completion.
  LOG('Host: starting a run…')
  await hostCall('POST', `/api/teams/${officeId}/run`)
  LOG('Host: run started.')

  // ── Summary / assertions ──
  const remoteMembers = roster.filter((m) => m.origin === 'remote')
  const presenceCount = presence?.nodes?.length ?? 0
  console.log('\n================ DEMO RESULT ================')
  console.log(JSON.stringify({
    officeId,
    presenceNodes: presenceCount,
    expectedNodes,
    remoteMembers: remoteMembers.length,
    roster,
  }, null, 2))
  console.log('=============================================')

  const ok = presenceCount >= expectedNodes && remoteMembers.length >= joiners.length
  if (!ok) {
    console.error('[demo] FAILED: presence did not converge or remote members missing.')
    process.exit(2)
  }
  LOG('SUCCESS: federation join + presence + remote roster verified over HTTP.')
}

main().catch((err) => {
  console.error('[demo] ERROR:', err.stack || err.message)
  process.exit(1)
})
