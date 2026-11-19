import type { HaloAPI } from '../../../src/preload'
import { buildTeamSessionKey } from '../../../src/shared/apps/im-keys'
import { test, expect, acceptance, openAutomation, readAutomationActivity, startAutomation, waitForAutomationResult } from '../fixtures/acceptance-automation'
import { sendAcceptanceMessage, waitForAcceptanceIdle, readAcceptanceConversation } from '../fixtures/acceptance-app'
import { collaboratorReceipt, type CollaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { initialUserInput, type ModelRequest, type ModelReply } from '../fixtures/acceptance-model'
import { promptOf } from '../fixtures/acceptance-team-awareness'
import { planModelTool } from '../fixtures/acceptance-tool-discovery'
import { navigateToChat } from '../fixtures/helpers'

test.setTimeout(180000)

const sourceTask = 'SPACE_REPORT_BOUNDARY: delegate the check to a direct collaborator who delegates its own check.'
const directTask = 'DIRECT_REPORT_BOUNDARY: create a nested checker and relay its findings and blocker to lead.'
const nestedTask = 'NESTED_REPORT_BOUNDARY: report the verified result and missing approval to your requester.'
const checked = 'The nested check verified alpha-583.'
const blocked = 'The nested check is blocked on owner approval for beta-926; no action was taken.'
const combined = `${checked} ${blocked}`
const milestone = 'The digital human retained its reporting channel after delegation.'

function boundaryScript(digitalHuman = false) {
  const errors: string[] = []
  const directRequests: ModelRequest[] = []
  const nestedRequests: ModelRequest[] = []
  const members: CollaboratorReceipt[] = []
  const delivered = new Set<string>()
  const tool = (request: ModelRequest, name: string, input: Record<string, unknown>, id: string): ModelReply => {
    const next = planModelTool(request, name, input, id)
    if ('error' in next) { errors.push(next.error); return { text: 'The requested collaboration tool was unavailable.' } }
    if (next.call.name === 'CallTool') {
      const definition = request.body.tools.find((entry: Record<string, any>) => (entry.function?.name ?? entry.name) === 'CallTool')
      const schema = definition?.input_schema ?? definition?.function?.parameters
      if (schema?.properties?.arguments?.type === 'object') next.call.input.arguments = input
    }
    return { tools: [next.call] }
  }
  const receipt = (request: ModelRequest, id: string, index: number) => {
    const result = request.toolResults.find(item => item.id === id)
    if (!result) return false
    try { members[index] = collaboratorReceipt(result) } catch (error) { errors.push(String(error)) }
    return true
  }
  const reply = (request: ModelRequest): ModelReply => {
    const assignment = initialUserInput(request)
    if (assignment.includes(nestedTask)) {
      nestedRequests.push(request)
      for (const [suffix, message] of [['result', checked], ['blocker', blocked]]) {
        const id = `nested-${suffix}`
        const result = request.toolResults.find(item => item.id === id)
        if (!result) return tool(request, 'team_send', { to: 'lead', message }, id)
        if (result.error) errors.push(`${id}: ${result.text}`)
        else delivered.add(id)
      }
      return { text: combined }
    }
    if (assignment.includes(directTask)) {
      directRequests.push(request)
      if (!digitalHuman && !receipt(request, 'nested-spawn', 1)) {
        return tool(request, 'spawn_agent', { name: 'Nested checker', prompt: nestedTask }, 'nested-spawn')
      }
      if (!digitalHuman && !(request.text.includes(checked) && request.text.includes(blocked))) return { text: 'Waiting for the nested checker.' }
      if (digitalHuman) {
        const report = request.toolResults.find(item => item.id === 'member-milestone')
        if (!report) return tool(request, 'report_to_user', { type: 'milestone', message: 'The delegated digital-human checker published its audit milestone.' }, 'member-milestone')
        if (report.error) errors.push(`member-milestone: ${report.text}`)
        else delivered.add('member-milestone')
      }
      const result = request.toolResults.find(item => item.id === 'direct-report')
      if (!result) return tool(request, 'team_send', { to: 'lead', message: combined, ...(digitalHuman ? {} : { summary: 'Verification results' }) }, 'direct-report')
      if (result.error) errors.push(`direct-report: ${result.text}`)
      else delivered.add('direct-report')
      return { text: combined }
    }
    if (!receipt(request, 'direct-spawn', 0)) return tool(request, 'spawn_agent', { name: 'Direct checker', prompt: directTask, ...(digitalHuman ? {} : { description: 'Check the evidence' }) }, 'direct-spawn')
    if (!(request.text.includes(checked) && request.text.includes(blocked))) return { text: 'The delegated check is working.' }
    if (digitalHuman) {
      const saved = request.toolResults.find(item => item.id === 'digital-milestone')
      if (!saved) return tool(request, 'report_to_user', { type: 'milestone', message: milestone }, 'digital-milestone')
      if (saved.error) errors.push(`digital-milestone: ${saved.text}`)
      const attempts = request.toolResults.filter(item => /^digital-complete-\d+$/.test(item.id))
      if (!attempts.some(item => !item.error && item.text.startsWith('Report saved (entry:'))) {
        return tool(request, 'report_to_user', { type: 'run_complete', message: combined }, `digital-complete-${attempts.length}`)
      }
    }
    return { text: combined }
  }
  return { reply, errors, directRequests, nestedRequests, members, delivered }
}

function expectTeamGuidance(request: ModelRequest, reportAvailable: boolean) {
  const prompt = promptOf(request)
  expect(prompt).toContain('Send teammate replies/results to the actual requester with `team_send(to, message)`')
  expect(prompt).toContain('No silent failure: send blockers or missing data to the requester with `team_send`')
  if (reportAvailable) {
    expect(prompt).toContain('- Only when you need a HUMAN decision, call')
    expect(prompt).toContain('`report_to_user({type:"escalation", message:"Your question", choices:["Option A", "Option B"]})`.')
    expect(prompt).toContain('- Escalation preference:')
    expect(prompt).toContain('report_to_user')
  } else {
    expect(prompt).not.toContain('report_to_user')
    expect(prompt).not.toContain('- Only when you need a HUMAN decision, call')
    expect(prompt).not.toContain('- Escalation preference:')
    expect(request.tools.filter(name => /(?:^|__)report_to_user$/.test(name))).toEqual([])
    expect(JSON.stringify(request.body.tools)).not.toContain('halo-report')
  }
}

test('ordinary space collaborators report results and blockers through their requester at both depths', acceptance('teams.collaboration.space-report-boundary'), async ({ model, automation, window }, testInfo) => {
  const script = boundaryScript()
  model.respond(script.reply)
  await navigateToChat(window)
  const baseline = await readAutomationActivity(window, automation.appId)
  await window.evaluate(() => {
    const state = globalThis as unknown as { halo: HaloAPI; boundaryEvents?: { activity: unknown[]; escalation: unknown[]; toast: unknown[]; dispose: () => void } }
    const events = { activity: [] as unknown[], escalation: [] as unknown[], toast: [] as unknown[], dispose: () => {} }
    const stops = [state.halo.onAppActivityEntry(value => events.activity.push(value)), state.halo.onAppEscalation(value => events.escalation.push(value)), state.halo.onNotificationToast(value => events.toast.push(value))]
    events.dispose = () => stops.forEach(stop => stop())
    state.boundaryEvents = events
  })
  try {
    const turn = await sendAcceptanceMessage(window, sourceTask)
    await expect(window.locator('.message-assistant [data-message-content]').filter({ hasText: combined }).last()).toBeVisible({ timeout: 120000 })
    await waitForAcceptanceIdle(window, turn.conversationId)
    expect(script.members).toHaveLength(2)
    expect(new Set(script.members.map(member => member.handle)).size).toBe(2)
    expect([...script.delivered].sort()).toEqual(['direct-report', 'nested-blocker', 'nested-result'])
    expect(script.errors).toEqual([])
    const association = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), turn.conversationId)
    expect(association.success).toBe(true)
    const scope = association.data as { teamId: string; epochId: string; members: Array<{ appId: string }> }
    expect(scope.members.map(member => member.appId)).toEqual([script.members[0].handle])
    const directKey = buildTeamSessionKey(script.members[0].handle, scope.teamId, scope.epochId)
    const nestedAssociation = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), directKey)
    expect(nestedAssociation.success).toBe(true)
    const nestedScope = nestedAssociation.data as typeof scope
    expect(nestedScope.members.map(member => member.appId)).toEqual([script.members[1].handle])
    for (const [index, member] of script.members.entries()) {
      const memberScope = index === 0 ? scope : nestedScope
      const conversationId = buildTeamSessionKey(member.handle, memberScope.teamId, memberScope.epochId)
      await waitForAcceptanceIdle(window, conversationId)
      const transcript = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: member.handle, spaceId: turn.spaceId, conversationId })
      expect(transcript.success).toBe(true)
      expect(transcript.data!.messages.some(message => message.role === 'assistant' && message.content.includes(checked) && message.content.includes(blocked))).toBe(true)
      const activity = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appGetActivity({ appId }), member.handle)
      expect(activity.success).toBe(true)
      expect(activity.data).toEqual([])
    }
    for (const requests of [script.directRequests, script.nestedRequests]) {
      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) expectTeamGuidance(request, false)
    }
    const stored = await readAcceptanceConversation(window, turn.spaceId, turn.conversationId)
    expect(stored.messages.some(message => message.role === 'assistant' && message.content.includes(combined))).toBe(true)
    expect(await readAutomationActivity(window, automation.appId)).toEqual(baseline)
    const events = await window.evaluate(() => {
      const events = (globalThis as unknown as { boundaryEvents: { activity: unknown[]; escalation: unknown[]; toast: unknown[] } }).boundaryEvents
      return { activity: events.activity, escalation: events.escalation, toast: events.toast }
    })
    expect(events).toEqual({ activity: [], escalation: [], toast: [] })
    await testInfo.attach('space-report-boundary', { body: JSON.stringify({ scope, members: script.members, delivered: [...script.delivered], requestCounts: [script.directRequests.length, script.nestedRequests.length], events }), contentType: 'application/json' })
  } finally {
    await window.evaluate(() => (globalThis as unknown as { boundaryEvents?: { dispose: () => void } }).boundaryEvents?.dispose())
  }
})

test('digital-human delegation retains reporting guidance and publishes a visible milestone', acceptance('teams.collaboration.digital-human-reporting'), async ({ model, automation, window }, testInfo) => {
  const script = boundaryScript(true)
  model.respond(script.reply)
  await openAutomation(window, automation)
  const run = await startAutomation(window, automation.appId)
  await waitForAutomationResult(window, automation.appId, run.runId, 'ok')
  expect(script.errors).toEqual([])
  expect(script.members).toHaveLength(1)
  expect(script.directRequests.length).toBeGreaterThan(0)
  for (const request of script.directRequests) expectTeamGuidance(request, true)
  const association = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), `app-run:${automation.appId}:${run.runId}`)
  expect(association.success).toBe(true)
  const scope = association.data as { teamId: string; epochId: string }
  const memberKey = buildTeamSessionKey(script.members[0].handle, scope.teamId, scope.epochId)
  await waitForAcceptanceIdle(window, memberKey)
  expect(script.delivered.has('member-milestone')).toBe(true)
  const memberActivity = await readAutomationActivity(window, script.members[0].handle)
  expect(memberActivity.filter(entry => entry.type === 'milestone' && entry.content.summary === 'The delegated digital-human checker published its audit milestone.')).toHaveLength(1)
  const entries = (await readAutomationActivity(window, automation.appId)).filter(entry => entry.runId === run.runId)
  expect(entries.filter(entry => entry.type === 'milestone' && entry.content.summary === milestone)).toHaveLength(1)
  expect(entries.some(entry => entry.type === 'run_complete' && entry.content.summary === combined)).toBe(true)
  await expect(window.getByText(milestone, { exact: true })).toBeVisible()
  await testInfo.attach('digital-human-reporting', { body: JSON.stringify({ runId: run.runId, member: script.members[0], entries }), contentType: 'application/json' })
})
