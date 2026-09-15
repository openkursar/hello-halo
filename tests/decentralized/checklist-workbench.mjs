import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clusterStart, clusterStop, apiOk, pollUntil } from './_lib.mjs'

const clusterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-workbench-live-'))
let node
let failures = 0
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  clusterStop(clusterDir)
  fs.rmSync(clusterDir, { recursive: true, force: true })
}
process.once('SIGINT', () => { cleanup(); process.exit(130) })
process.once('SIGTERM', () => { cleanup(); process.exit(143) })
const check = async (name, body) => {
  const started = Date.now()
  try {
    await body()
    console.log(`PASS ${name} (${Math.round((Date.now() - started) / 1000)}s)`)
    return true
  } catch (error) {
    failures++
    console.error(`FAIL ${name}: ${error.message}`)
    return false
  }
}
try {
  const manifest = clusterStart({ nodes: 1, basePort: 3870, fresh: false, clusterDir })
  node = manifest.nodes[0]
  const space = await apiOk(node, 'POST', '/api/spaces', { name: 'Workbench verification', icon: '🧪' })
  const team = await apiOk(node, 'POST', '/api/teams', {
    input: { name: 'Workbench verification', goal: 'Follow explicit user requests precisely. Do not start unsolicited work. Use team tools when requested.', owningSpaceId: space.id, memberSourcing: 'ai', collabMode: 'structured', escalationRouting: 'user' },
    confirmedProposal: [
      { memberName: 'Reviewer', role: 'reviewer', responsibility: 'When contacted by a teammate, acknowledge once with team_send to that teammate, then end your turn. When the human asks a question, answer directly. Never initiate unrelated work.' },
      { memberName: 'Observer', role: 'observer', responsibility: 'Answer only when explicitly addressed. Do not contact other teammates.' },
    ],
  })
  const detail = () => apiOk(node, 'GET', `/api/teams/${team.id}/detail`)
  const roster = await detail()
  const lead = team.leadAppId
  const reviewer = roster.members.find(member => member.memberName === 'Reviewer').appId
  const observer = roster.members.find(member => member.memberName === 'Observer').appId
  const taskA = await apiOk(node, 'POST', `/api/teams/${team.id}/conversations`, { title: 'Release review' })
  const taskB = await apiOk(node, 'POST', `/api/teams/${team.id}/conversations`, { title: 'Independent request' })
  const history = (epochId, appId) => apiOk(node, 'GET', `/api/teams/${team.id}/chat-messages?epochId=${epochId}&appId=${appId}`)
  const send = (epochId, appId, message) => apiOk(node, 'POST', `/api/teams/${team.id}/members/${appId}/send`, { epochId, message })
  const conversations = () => apiOk(node, 'GET', `/api/teams/${team.id}/conversations`)
  const waitAnswer = (epochId, appId, marker) => pollUntil(async () => {
    const messages = await history(epochId, appId)
    return messages.some(message => message.role === 'assistant' && message.content.includes(marker)) ? messages : null
  }, { timeoutMs: 180000, intervalMs: 1500 })

  const completionDiagnostics = async (epochId, appId) => {
    const diagnostics = await Promise.allSettled([
      conversations(),
      apiOk(node, 'GET', `/api/teams/${team.id}/epochs/${epochId}/board`),
      history(epochId, appId),
      detail(),
    ])
    const value = index => diagnostics[index].status === 'fulfilled' ? diagnostics[index].value : { error: String(diagnostics[index].reason?.message ?? diagnostics[index].reason) }
    const taskList = value(0)
    const board = value(1)
    const messages = value(2)
    const current = value(3)
    console.error('Completion diagnostics', JSON.stringify({
      task: Array.isArray(taskList) ? taskList.find(task => task.epochId === epochId) : taskList,
      epoch: board.epoch,
      activity: board.activities?.map(activity => ({ kind: activity.kind, actorAppId: activity.actorAppId, subject: activity.subject, status: activity.status, createdAt: activity.createdAt })),
      lastLeadMessages: Array.isArray(messages) ? messages.slice(-6).map(message => ({ role: message.role, content: message.content?.slice(-4000), error: message.error, metadata: message.metadata })) : messages,
      lead: current.roster?.find(member => member.appId === appId),
      errors: diagnostics.flatMap((result, index) => result.status === 'rejected' ? [{ request: index, error: String(result.reason?.message ?? result.reason) }] : []),
    }, null, 2))
  }

  await check('native tasks retain distinct identities and creator relationship', async () => {
    assert.notEqual(taskA.epochId, taskB.epochId)
    const tasks = await conversations()
    assert(tasks.find(task => task.epochId === taskA.epochId)?.createdByMe)
    assert(tasks.find(task => task.epochId === taskB.epochId)?.createdByMe)
  })
  const humanReady = await check('human conversation persists with provenance and stays member scoped', async () => {
    await send(taskA.epochId, lead, 'Reply with exactly WORKBENCH_HELLO. Do not use tools, delegate, or complete the task.')
    const messages = await waitAnswer(taskA.epochId, lead, 'WORKBENCH_HELLO')
    assert(messages, 'No real model reply within 180 seconds')
    assert(messages.some(message => message.role === 'user' && message.metadata?.teamTriggerKind === 'human_message'))
    assert.equal((await history(taskA.epochId, observer)).length, 0)
  })
  if (!humanReady) throw new Error('Live model prerequisite failed; dependent generation checks were not run.')

  await check('direct human chat with a member does not wake the lead', async () => {
    const before = await history(taskA.epochId, lead)
    await apiOk(node, 'POST', `/api/apps/${reviewer}/chat/send`, {
      spaceId: space.id,
      conversationId: `app-chat:${reviewer}:team:${team.id}:${taskA.epochId}`,
      message: 'Reply exactly WORKBENCH_PRIVATE_REPLY. This is a human conversation. Do not use tools or contact teammates.',
    })
    assert(await waitAnswer(taskA.epochId, reviewer, 'WORKBENCH_PRIVATE_REPLY'))
    // Observe beyond the report coalescing window, including delayed wakes.
    await new Promise(resolve => setTimeout(resolve, 17000))
    assert.deepEqual((await history(taskA.epochId, lead)).map(message => message.id), before.map(message => message.id))
  })

  await check('second task has its own conversation context', async () => {
    await send(taskB.epochId, lead, 'Reply with exactly WORKBENCH_SECOND. Do not use tools, delegate, or complete the task.')
    assert(await waitAnswer(taskB.epochId, lead, 'WORKBENCH_SECOND'))
    assert(!(await history(taskA.epochId, lead)).some(message => message.content.includes('WORKBENCH_SECOND')))
  })
  await check('directed collaboration is recorded once and preserves receiver provenance', async () => {
    await send(taskA.epochId, lead, 'Use team_send once with to="Reviewer" and message="WORKBENCH_COLLAB: acknowledge this to Lead once using team_send, then stop." Then reply WORKBENCH_SENT. Do not complete the task or send any additional messages.')
    const collab = await pollUntil(async () => {
      const board = await apiOk(node, 'GET', `/api/teams/${team.id}/epochs/${taskA.epochId}/board`)
      return board.activities?.find(activity => activity.kind === 'message' && activity.actorAppId === lead && activity.targetAppId === reviewer && (activity.body || activity.subject).includes('WORKBENCH_COLLAB')) ? board : null
    }, { timeoutMs: 180000, intervalMs: 1500 })
    assert(collab, 'Directed coordination record was not observed')
    const received = await pollUntil(async () => {
      const messages = await history(taskA.epochId, reviewer)
      return messages.find(message => message.role === 'user' && message.metadata?.teamTriggerKind === 'message')
    }, { timeoutMs: 60000, intervalMs: 1000 })
    assert(received, 'Receiver transcript lacks internal provenance')
    assert.equal((await history(taskA.epochId, observer)).length, 0)
    assert.equal(collab.activities.filter(activity => activity.kind === 'message' && activity.actorAppId === lead && activity.targetAppId === reviewer && (activity.body || activity.subject).includes('WORKBENCH_COLLAB')).length, 1)
  })
  await check('archived task remains readable and resumes without losing history', async () => {
    await apiOk(node, 'DELETE', `/api/teams/${team.id}/conversations/${taskB.epochId}`)
    assert((await conversations()).find(task => task.epochId === taskB.epochId)?.completed)
    assert((await history(taskB.epochId, lead)).some(message => message.content.includes('WORKBENCH_SECOND')))
    await send(taskB.epochId, lead, 'Reply with exactly WORKBENCH_REOPENED. Do not use tools or complete the task.')
    assert(await waitAnswer(taskB.epochId, lead, 'WORKBENCH_REOPENED'))
    assert.equal((await conversations()).find(task => task.epochId === taskB.epochId)?.completed, false)
  })
  await check('two decisions for one digital human remain independently answerable', async () => {
    for (const [epochId, marker] of [[taskA.epochId, 'DECISION_ALPHA'], [taskB.epochId, 'DECISION_BETA']]) {
      await send(epochId, reviewer, `Call report_to_user with type="escalation", message="${marker}: approve this internal test?", choices=["Approve","Reject"]. This is an explicit request to ask me; do not choose for me. End the turn after reporting. When I answer, reply with ${marker}_ANSWERED and do not ask again.`)
    }
    const waiting = await pollUntil(async () => {
      const d = await detail()
      return d.pendingEscalations?.filter(entry => entry.appId === reviewer).length === 2 ? d.pendingEscalations.filter(entry => entry.appId === reviewer) : null
    }, { timeoutMs: 240000, intervalMs: 2000 })
    assert(waiting, 'Both independent questions were not observed')
    assert.equal(new Set(waiting.map(entry => entry.epochId)).size, 2)
    for (const entry of waiting) await apiOk(node, 'POST', `/api/apps/${reviewer}/escalation/${entry.entryId}/respond`, { choice: 'Approve' })
    assert(await waitAnswer(taskA.epochId, reviewer, 'DECISION_ALPHA_ANSWERED'))
    assert(await waitAnswer(taskB.epochId, reviewer, 'DECISION_BETA_ANSWERED'))
    assert.equal((await detail()).pendingEscalations.filter(entry => entry.appId === reviewer).length, 0)
  })
  await check('published output belongs to its task and resolves to a real file', async () => {
    await send(taskA.epochId, reviewer, 'Write a file reviewer-verification.md in your working directory containing exactly WORKBENCH_OUTPUT. Then call team_post_finding with content="Verification output" and ref="reviewer-verification.md". Do not send messages to teammates or ask questions. Reply OUTPUT_PUBLISHED when finished.')
    assert(await waitAnswer(taskA.epochId, reviewer, 'OUTPUT_PUBLISHED'))
    const groups = await apiOk(node, 'GET', `/api/teams/${team.id}/epochs/${taskA.epochId}/artifacts`)
    const artifact = groups.flatMap(group => group.artifacts).find(file => file.name.endsWith('reviewer-verification.md'))
    assert(artifact, 'Published output was not listed for the task')
    assert(fs.readFileSync(artifact.path, 'utf8').includes('WORKBENCH_OUTPUT'))
    const otherGroups = await apiOk(node, 'GET', `/api/teams/${team.id}/epochs/${taskB.epochId}/artifacts`)
    assert(!otherGroups.flatMap(group => group.artifacts).some(file => file.name.endsWith('reviewer-verification.md')))
  })
  await check('lead completion preserves both task identity and collaboration history', async () => {
    await send(taskA.epochId, lead, 'All verification work is done and approved. Call team_complete now with summary="WORKBENCH_COMPLETE: verified collaboration and reviewer output." Do not delegate or start more work.')
    const completed = await pollUntil(async () => (await conversations()).find(task => task.epochId === taskA.epochId && task.completed), { timeoutMs: 120000, intervalMs: 1500 })
    if (!completed) await completionDiagnostics(taskA.epochId, lead)
    assert(completed, 'Explicit completion did not mark the task complete')
    const board = await apiOk(node, 'GET', `/api/teams/${team.id}/epochs/${taskA.epochId}/board`)
    assert(board.activities.some(activity => activity.kind === 'run_end'))
    assert(board.activities.some(activity => activity.kind === 'message'))
    assert((await history(taskA.epochId, lead)).some(message => message.content.includes('WORKBENCH_HELLO')))
  })

  await check('direct app chat completion closes its task without losing the conversation', async () => {
    const task = await apiOk(node, 'POST', `/api/teams/${team.id}/conversations`, { title: 'Direct completion verification' })
    const conversationId = `app-chat:${lead}:team:${team.id}:${task.epochId}`
    await apiOk(node, 'POST', `/api/apps/${lead}/chat/send`, {
      spaceId: space.id,
      conversationId,
      message: 'This verification task requires no other work. Call team_complete now with summary="WORKBENCH_DIRECT_COMPLETE: verified direct conversation completion." Do not delegate, ask questions, or start more work. End your turn after the tool call.',
    })
    const completed = await pollUntil(async () => (await conversations()).find(row => row.epochId === task.epochId && row.completed), { timeoutMs: 180000, intervalMs: 1500 })
    if (!completed) await completionDiagnostics(task.epochId, lead)
    assert(completed, 'Direct chat completion did not mark the task complete')
    const board = await apiOk(node, 'GET', `/api/teams/${team.id}/epochs/${task.epochId}/board`)
    assert(board.activities.some(activity => activity.kind === 'run_end' && (activity.body || activity.subject).includes('WORKBENCH_DIRECT_COMPLETE')))
    assert((await history(task.epochId, lead)).some(message => message.role === 'user' && message.content.includes('WORKBENCH_DIRECT_COMPLETE')))
    assert.equal((await history(task.epochId, observer)).length, 0)
  })

} catch (error) {
  failures++
  console.error(`FAIL workbench live suite: ${error.message}`)
} finally {
  cleanup()
  console.log(`Workbench live verification: ${failures} failures`)
  if (failures) process.exitCode = 1
}
