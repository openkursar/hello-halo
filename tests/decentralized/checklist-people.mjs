import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { api, apiOk, clusterStart, clusterStop, pollUntil } from './_lib.mjs'

const clusterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-people-live-'))
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  clusterStop(clusterDir)
  fs.rmSync(clusterDir, { recursive: true, force: true })
}
process.once('SIGINT', () => { cleanup(); process.exit(130) })
process.once('SIGTERM', () => { cleanup(); process.exit(143) })
const passed = name => console.log(`PASS ${name}`)

try {
  const node = clusterStart({ nodes: 1, basePort: 3890, fresh: false, clusterDir }).nodes[0]
  const space = await apiOk(node, 'POST', '/api/spaces', { name: 'Original evidence workspace', icon: '🧪' })
  const target = await apiOk(node, 'POST', '/api/spaces', { name: 'Future evidence workspace', icon: '🧪' })
  const installed = await apiOk(node, 'POST', '/api/apps/install', { spaceId: space.id, spec: {
    spec_version: '1', name: 'Decision evidence reviewer', version: '1.0', author: 'e2e',
    type: 'automation', description: 'Verifies independent decisions and recovery.',
    system_prompt: 'For each new independent execution, call report_to_user once with type="escalation", message="PEOPLE_DECISION: approve this verification?", choices=["Approve","Reject"], and then stop. When the user answers Approve, call report_to_user with type="run_complete", message="PEOPLE_RESUMED", and stop. In private chat answer the direct request; do not ask for this automated approval in private chat.',
    subscriptions: [], requires: {}, config_schema: [], permissions: [],
  } })
  const appId = installed.appId
  const base = `/api/apps/${appId}`
  const pending = () => apiOk(node, 'GET', `${base}/pending-entries`)
  const entry = id => apiOk(node, 'GET', `${base}/activity/${id}`)
  const state = () => apiOk(node, 'GET', `${base}/state`)
  const waitPending = count => pollUntil(async () => { const entries = await pending(); return entries.length === count ? entries : null }, { timeoutMs: 180000, intervalMs: 1000 })

  const started = await apiOk(node, 'POST', `${base}/runs/start`)
  assert.equal(started.outcome, 'started')
  const first = (await waitPending(1))?.[0]
  assert(first, 'The real model did not produce the first decision')
  await apiOk(node, 'POST', `${base}/pause`)
  assert.equal((await state()).automaticEnabled, false)
  assert.equal((await entry(first.id)).userResponse, undefined)
  const doubleStart = await Promise.all([api(node, 'POST', `${base}/runs/start`), api(node, 'POST', `${base}/runs/start`)])
  assert.equal(doubleStart.filter(result => result.json?.success).length, 1)
  const two = await waitPending(2)
  assert(two, 'Manual execution while paused did not produce an independent question')
  assert.equal(new Set(two.map(item => item.runId)).size, 2)
  assert.equal((await state()).automaticEnabled, false)
  passed('pause preserves the question; Run once admits one independent execution without enabling automation')

  const preview = await apiOk(node, 'POST', `${base}/space-preview`, { newSpaceId: target.id })
  assert.equal(preview.pendingDecisionCount, 2)
  await apiOk(node, 'POST', `${base}/move-space`, { newSpaceId: target.id })
  assert.equal((await apiOk(node, 'GET', base)).spaceId, target.id)
  const before = await apiOk(node, 'GET', `${base}/runs/${first.runId}/session`)
  assert(before.length > 0, 'Original execution transcript is unavailable after default-space change')
  const answers = await Promise.all([
    api(node, 'POST', `${base}/escalation/${first.id}/respond`, { choice: 'Approve' }),
    api(node, 'POST', `${base}/escalation/${first.id}/respond`, { choice: 'Approve' }),
  ])
  assert(answers.every(result => result.json?.success), 'An idempotent duplicate answer was not acknowledged')
  const completed = await pollUntil(async () => { const value = await entry(first.id); return value.continuation?.status === 'completed' ? value : null }, { timeoutMs: 180000, intervalMs: 1000 })
  assert(completed, 'The original execution did not continue')
  assert.equal(completed.runId, first.runId)
  assert.equal(completed.userResponse.choice, 'Approve')
  assert.equal((await state()).automaticEnabled, false)
  assert.equal((await pending()).length, 1)
  const after = await apiOk(node, 'GET', `${base}/runs/${first.runId}/session`)
  assert(after.length > before.length)
  assert(JSON.stringify(after).includes('PEOPLE_RESUMED'))
  assert(after.filter(message => message.role === 'user').length === before.filter(message => message.role === 'user').length + 1, 'Duplicate answer caused more than one continuation turn')
  passed('remote duplicate answers continue the original run once in its original environment after a default-space change')

  const second = (await pending())[0]
  await apiOk(node, 'POST', `${base}/runs/${second.runId}/close`)
  const closed = await entry(second.id)
  assert.equal(closed.content.resolution.reason, 'task_closed')
  assert.equal(closed.userResponse, undefined)
  assert.equal((await api(node, 'POST', `${base}/escalation/${second.id}/respond`, { choice: 'Approve' })).json.success, false)
  assert.equal((await pending()).length, 0)
  passed('closing one task preserves audit history and never impersonates a user answer')

  const team = await apiOk(node, 'POST', '/api/teams', { input: { name: 'Evidence relations team', goal: 'Do not run unsolicited work.', owningSpaceId: target.id, memberSourcing: 'manual', collabMode: 'structured', escalationRouting: 'user' } })
  await apiOk(node, 'POST', `/api/teams/${team.id}/members`, { appId, memberName: 'Evidence reviewer', role: 'Evidence reviewer' })
  await apiOk(node, 'POST', `${base}/chat/send`, { spaceId: target.id, message: 'Use read_digital_human_context with section teams to retrieve your current team memberships. Report the team name and your role exactly. Do not use any other tool or ask for approval.' })
  const context = await pollUntil(async () => {
    const messages = await apiOk(node, 'GET', `${base}/chat/messages`)
    return messages.some(message => message.role === 'assistant' && message.content?.includes('Evidence relations team')) ? messages : null
  }, { timeoutMs: 180000, intervalMs: 1000 })
  assert(context, 'Real model did not answer using its current relationship')
  assert(JSON.stringify(context).includes('read_digital_human_context'), 'Relationship tool was not called')
  assert(JSON.stringify(context).includes(team.id), 'Structured team reference is absent')
  passed('private chat queries real memberships through the read-only tool and persists a structured team reference')

  const unauthenticated = await fetch(`${node.baseUrl}/api/apps/pending-inbox`)
  assert.equal(unauthenticated.status, 401)
  const directory = await apiOk(node, 'GET', '/api/apps/people?limit=24')
  assert(directory.items.some(person => person.id === appId))
  assert(!JSON.stringify(directory).includes('system_prompt'))
  assert(!JSON.stringify(directory).includes('userConfig'))
  passed('remote summaries remain authenticated and exclude full private configurations')
} catch (error) {
  console.error(`FAIL digital human live verification: ${error.stack ?? error.message}`)
  process.exitCode = 1
} finally { cleanup() }
