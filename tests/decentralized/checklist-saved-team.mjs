import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import * as current from './_lib.mjs'

const legacyRoot = process.argv[process.argv.indexOf('--legacy-root') + 1]
if (!process.argv.includes('--legacy-root') || !legacyRoot) throw new Error('Supply --legacy-root pointing to a built checkout from before the save fix.')
const legacy = await import(pathToFileURL(path.join(path.resolve(legacyRoot), 'tests/decentralized/_lib.mjs')))
const directory = mkdtempSync(path.join(tmpdir(), 'halo-saved-team-compat-'))
const currentDir = path.join(directory, 'current')
const legacyDir = path.join(directory, 'legacy')
const { apiOk, createOffice, firstNonLeadAppId, mintInvite, joinOffice, pollUntil } = current
let passed = 0
const pass = name => { passed++; console.log(`PASS ${name}`) }

async function read(node, id) { return apiOk(node, 'GET', `/api/teams/${id}/detail`) }
async function tasks(node, id) { return apiOk(node, 'GET', `/api/teams/${id}/conversations`) }
async function invite(node, id) {
  const result = await mintInvite(node, id)
  assert.equal(result.success, true)
  return result.data.token
}
async function consistent(host, peer, id) {
  const result = await pollUntil(async () => {
    const left = await read(host, id)
    const right = await read(peer, id)
    const ids = detail => detail.members.map(member => member.appId).sort().join(',')
    return left.team.leadAppId === right.team.leadAppId && ids(left) === ids(right) ? [left, right] : null
  })
  assert.ok(result, 'The old and new clients must converge on the same ordinary roster and lead')
  return result
}

// Only fixture data is written directly. Every save, repair, join and task uses
// the production HTTP surface on independently built, real Electron processes.
function seedSource(node, spaceId, memberAppId, persistent = false) {
  const id = randomUUID()
  const conversationId = randomUUID()
  const epochId = randomUUID()
  const coordinator = `space-conv-${conversationId}`
  execFileSync('python3', ['-c', `
import json,sqlite3,sys,time
p=json.loads(sys.argv[1]); now=int(time.time()*1000)
db=sqlite3.connect(p['database'],timeout=15)
with db:
 db.execute("INSERT INTO teams(id,name,owning_space_id,goal,lead_app_id,member_sourcing,collab_mode,escalation_routing,status,created_at,updated_at,ephemeral,coordinator_conversation_id) VALUES (?,?,?,?,?,'ai','free','user','idle',?,?,?,?)",(p['id'],p['id'],p['spaceId'],'Research products',p['coordinator'],now,now,0 if p['persistent'] else 1,p['conversationId']))
 db.execute("INSERT INTO team_members(team_id,app_id,member_name,role,is_lead,ai_provisioned,is_system_coordinator,added_at) VALUES (?,?,'coordinator','Coordinator',1,0,1,?)",(p['id'],p['coordinator'],now))
 db.execute("INSERT INTO team_members(team_id,app_id,member_name,role,is_lead,ai_provisioned,added_at,duty) VALUES (?,?,'Researcher','Research',0,0,?,'Compare product capabilities')",(p['id'],p['memberAppId'],now))
 db.execute("INSERT INTO team_epochs(id,team_id,started_at,lifecycle,chat_key,title) VALUES (?,?,?,'conversation',?,'Original work')",(p['epochId'],p['id'],now,'space:'+p['conversationId']))
 db.execute("INSERT INTO blackboard_findings(id,team_id,epoch_id,author_app_id,body,ref,created_at) VALUES (?,?,?,?,'Original plan','plan.md',?)",(p['epochId']+'-plan',p['id'],p['epochId'],p['coordinator'],now))
db.close()
`, JSON.stringify({ database: path.join(node.dataDir, 'halo.db'), id, spaceId, memberAppId, coordinator, conversationId, epochId, persistent })], { stdio: 'pipe' })
  return { id, epochId, coordinator }
}

try {
  const host = current.clusterStart({ nodes: 1, basePort: 3860, clusterDir: currentDir, quiet: true }).nodes[0]
  const old = legacy.clusterStart({ nodes: 1, basePort: 3870, clusterDir: legacyDir, quiet: true }).nodes[0]
  assert.ok(host.ready && old.ready)
  const bench = await createOffice(host, { spaceName: 'Save fixture', teamName: 'Save fixture', goal: 'Research products', proposal: [{ memberName: 'Researcher', role: 'Research', responsibility: 'Compare products' }] })
  const worker = await firstNonLeadAppId(host, bench.team.id)
  const source = seedSource(host, bench.spaceId, worker)
  const saved = await apiOk(host, 'POST', `/api/teams/${source.id}/save-collab`, {})
  assert.notEqual(saved.id, source.id)
  assert.ok(saved.leadAppId && !saved.leadAppId.startsWith('space-conv-'))
  assert.deepEqual(await tasks(host, saved.id), [])
  const original = await read(host, source.id)
  assert.equal(original.team.ephemeral, true)
  assert.equal(original.team.leadAppId, source.coordinator)
  assert.equal((await apiOk(host, 'POST', `/api/teams/${source.id}/save-collab`, {})).id, saved.id)
  pass('save snapshots configuration, keeps the source, and is idempotent')

  const invitation = await invite(host, saved.id)
  const joined = await joinOffice(old, host, saved.id, invitation, 'old joining saved team')
  const [fresh, previous] = await consistent(host, old, saved.id)
  assert.equal(fresh.members.length, 3)
  assert.ok(previous.members.every(member => !member.appId.startsWith('space-conv-')))
  assert.ok(previous.members.some(member => member.appId === worker))
  pass('unchanged old client joins a newly saved team without learning a coordinator mode')

  const opened = await apiOk(old, 'POST', `/api/teams/${saved.id}/conversations`, { title: 'Created by old client' })
  assert.ok(await pollUntil(async () => (await tasks(host, saved.id)).some(task => task.epochId === opened.epochId)))
  await apiOk(host, 'PATCH', `/api/teams/${saved.id}`, { leadAppId: joined.bringAppId })
  assert.equal((await consistent(host, old, saved.id))[1].team.leadAppId, joined.bringAppId)
  pass('old client creates work and receives ordinary lead changes')

  const oldOffice = await createOffice(old, { spaceName: 'Old host', teamName: 'Old host', goal: 'Research products', proposal: [{ memberName: 'Old researcher', role: 'Research', responsibility: 'Compare products' }] })
  const oldWorker = await firstNonLeadAppId(old, oldOffice.team.id)
  await joinOffice(host, old, oldOffice.team.id, await invite(old, oldOffice.team.id), 'new joining old team')
  assert.equal((await consistent(old, host, oldOffice.team.id))[1].legacyCoordinator, undefined)
  pass('new client joins an ordinary team hosted by the unchanged old client')

  const brokenRemote = seedSource(old, oldOffice.spaceId, oldWorker, true)
  await joinOffice(host, old, brokenRemote.id, await invite(old, brokenRemote.id), 'legacy owner notice')
  const notice = await read(host, brokenRemote.id)
  assert.equal(notice.legacyCoordinator?.ownedHere, false)
  assert.ok(notice.legacyCoordinator && 'ownerName' in notice.legacyCoordinator)
  assert.equal((await read(old, brokenRemote.id)).team.leadAppId, brokenRemote.coordinator)
  const refused = await current.api(host, 'POST', `/api/teams/${brokenRemote.id}/conversations`, { title: 'Must wait for the creator' })
  assert.equal(refused.json.success, false)
  pass('new client identifies the old creator without changing their broken team')

  const brokenLocal = seedSource(host, bench.spaceId, worker, true)
  const oldLink = await invite(host, brokenLocal.id)
  const legacyMember = await joinOffice(old, host, brokenLocal.id, oldLink, 'repair propagation')
  const repaired = await read(host, brokenLocal.id)
  assert.equal(repaired.team.id, brokenLocal.id)
  assert.notEqual(repaired.team.leadAppId, brokenLocal.coordinator)
  const replicas = await consistent(host, old, brokenLocal.id)
  assert.ok(replicas[1].members.some(member => member.appId === legacyMember.bringAppId))
  assert.ok(replicas[1].members.every(member => member.appId !== brokenLocal.coordinator))
  assert.equal(await invite(host, brokenLocal.id), oldLink)
  assert.ok((await tasks(host, brokenLocal.id)).some(task => task.epochId === brokenLocal.epochId))
  pass('one-time owner repair preserves membership, invitation and history for an old peer')

  const publications = await apiOk(host, 'GET', `/api/teams/${brokenLocal.id}/epochs/${brokenLocal.epochId}/artifacts`)
  assert.ok(publications.some(group => group.appId === brokenLocal.coordinator && group.artifacts.some(artifact => artifact.relativePath === 'plan.md')))
  const sourceKey = `app-chat:${worker}:team:${brokenLocal.id}:${brokenLocal.epochId}`
  const history = await apiOk(host, 'GET', `/api/apps/${worker}/chat/transcript?conversationId=${encodeURIComponent(sourceKey)}`)
  assert.ok(Array.isArray(history.messages))
  pass('repaired teams keep original publications and remote history accessible')

  const sourceTask = (await tasks(host, brokenLocal.id)).find(task => task.epochId === brokenLocal.epochId)
  assert.equal(sourceTask.readonly, true)
  for (const action of ['send', 'inject']) {
    const refused = await current.api(host, 'POST', `/api/apps/${worker}/chat/${action}`, {
      spaceId: bench.spaceId, conversationId: sourceKey, message: 'Must not enter the historical task',
    })
    assert.equal(refused.status, 400)
    assert.equal(refused.json.success, false)
  }
  const direct = await current.api(host, 'POST', `/api/teams/${brokenLocal.id}/members/${worker}/send`, {
    epochId: brokenLocal.epochId, message: 'Must not enter the historical task',
  })
  assert.equal(direct.json.success, false)
  await apiOk(host, 'POST', `/api/apps/${worker}/chat/stop`, { conversationId: sourceKey })
  const afterRefusal = await apiOk(host, 'GET', `/api/apps/${worker}/chat/transcript?conversationId=${encodeURIComponent(sourceKey)}`)
  assert.deepEqual(afterRefusal.messages, history.messages)
  pass('unsealed source history refuses every new input while remaining readable and stoppable')

  await apiOk(host, 'DELETE', `/api/teams/${saved.id}`)
  assert.ok(!(await read(host, source.id)).team.savedTeamId)
  const savedAgain = await apiOk(host, 'POST', `/api/teams/${source.id}/save-collab`, {})
  assert.notEqual(savedAgain.id, saved.id)
  assert.equal((await read(host, source.id)).team.leadAppId, source.coordinator)
  pass('deleting a saved configuration leaves the original work and permits saving again')
  console.log(`Saved-team compatibility: ${passed} checks passed; no model calls required.`)
} finally {
  current.clusterStop(currentDir)
  legacy.clusterStop(legacyDir)
  rmSync(directory, { recursive: true, force: true })
}
