import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { Thought } from '../../../src/shared/types/transcript'
import { test, expect, sendAcceptanceMessage, waitForAcceptanceIdle, readAcceptanceConversation } from '../fixtures/acceptance-app'
import { test as automationTest, openAutomation, openAutomationProcess, startAutomation, waitForAutomationResult, readAutomationTranscript } from '../fixtures/acceptance-automation'
import { seedManagedSpace, seedManagedConversation, openManagedConversation } from '../fixtures/acceptance-management'
import { createAwareTeam, installTeammate, memberTranscript } from '../fixtures/acceptance-team-awareness'
import { startAcceptanceMcp } from '../fixtures/acceptance-mcp'
import { collaboratorReceipt, type CollaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { createToolDiscoveryScenario, planModelTool } from '../fixtures/acceptance-tool-discovery'
import { initialUserInput, modelTool, type ModelRequest } from '../fixtures/acceptance-model'

test.setTimeout(150000)
automationTest.setTimeout(150000)

const phases = ['discover', 'continue', 'restored', 'disabled'] as const

function binding(entry: string) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({
    caseId: 'capabilities.tool-discovery.application', evidence: 'app-e2e', mode: 'scripted', variant: { entry },
  }) } }
}

async function installService(page: Page, spaceId: string | null, url: string): Promise<InstalledApp> {
  const installed = await page.evaluate(({ spaceId, url }) => (globalThis as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId, spec: { spec_version: '1', type: 'mcp', name: 'Deferred receipt service', version: '1.0.0', author: 'Acceptance',
      description: 'Look up a supplied receipt through the isolated service.', mcp_server: { transport: 'streamable-http', command: url } },
  }), { spaceId, url })
  expect(installed.success).toBe(true)
  const loaded = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGet(id), (installed.data as { appId: string }).appId)
  expect(loaded.success).toBe(true)
  return loaded.data as InstalledApp
}

async function disableServiceTool(page: Page, appId: string) {
  const result = await page.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({
    appId, overrides: { disabledTools: ['echo_acceptance'] },
  }), appId)
  expect(result.success).toBe(true)
}

function assertTurn(scenario: ReturnType<typeof createToolDiscoveryScenario>, entry: string, phase: string, completionRequests = 0) {
  expect(scenario.issues).toEqual([])
  const requests = scenario.requests.get(phase)!
  expect(requests).toHaveLength((phase === 'discover' ? 3 : 2) + completionRequests)
  expect(requests[0].tools.some(name => name.endsWith('__echo_acceptance'))).toBe(false)
  for (const request of requests) expect(request.body.tools).toEqual(requests[0].body.tools)
  if (phase === 'discover') {
    expect(requests[0].tools).toEqual(expect.arrayContaining(['ToolSearch', 'CallTool']))
    expect(requests[0].text).not.toContain('Return the supplied acceptance value.')
    expect(requests[1].text).toContain('Return the supplied acceptance value.')
  } else if (phase !== 'disabled') {
    expect(requests[0].text).toContain('Return the supplied acceptance value.')
    expect(requests[0].text).toContain('input_schema')
  }
  if (phase === 'disabled') {
    expect(scenario.results.get(phase)).toMatch(/unavailable|not available|not found|not registered|not discovered|disabled|search/i)
    expect(scenario.results.get(phase)).not.toContain(`Service receipt: ${entry}-${phase}`)
  } else expect(scenario.results.get(phase)).toContain(`Service receipt: ${entry}-${phase}`)
}

test('space discovery survives application restart and respects a disabled real tool', binding('space'), async ({ acceptanceApp, window, model }, info) => {
  const service = await startAcceptanceMcp()
  const scenario = createToolDiscoveryScenario('space')
  let page = window
  try {
    const space = await seedManagedSpace(page, 'Discovery workspace')
    const connection = await installService(page, space.id, service.url)
    const conversation = await seedManagedConversation(page, space.id, 'Deferred receipt conversation', [])
    model.respond(scenario.respond)
    for (const phase of phases) {
      scenario.start(phase)
      if (phase === 'restored') page = await acceptanceApp.restart()
      if (phase === 'disabled') await disableServiceTool(page, connection.id)
      await openManagedConversation(page, conversation.title, space.id, { empty: phase === 'discover' })
      const turn = await sendAcceptanceMessage(page, `Use the receipt service for space-${phase}.`)
      expect(turn.conversationId).toBe(conversation.id)
      await expect(page.locator('.message-assistant').last()).toContainText(`Channel operation recorded: space-${phase}.`)
      await waitForAcceptanceIdle(page, conversation.id)
      assertTurn(scenario, 'space', phase)
      if (phase !== 'disabled') {
        const saved = await readAcceptanceConversation(page, space.id, conversation.id)
        const message = saved.messages.findLast(message => message.role === 'assistant')!
        const thoughts = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.getMessageThoughts(input.spaceId, input.conversationId, input.messageId), {
          spaceId: space.id, conversationId: conversation.id, messageId: message.id,
        })
        expect(thoughts.success).toBe(true)
        const tools = (thoughts.data as Thought[]).filter(thought => thought.type === 'tool_use')
        expect(tools.filter(tool => tool.toolName === scenario.target)).toHaveLength(1)
        expect(tools.some(tool => tool.toolName === 'CallTool')).toBe(false)
      }
    }
    expect(service.calls).toEqual(phases.slice(0, 3).map(phase => ({ value: `space-${phase}`, failed: false })))
    await info.attach('space-discovery', { body: JSON.stringify({ requests: [...scenario.requests], results: [...scenario.results], calls: service.calls }), contentType: 'application/json' })
  } finally { await service.close() }
})

automationTest('an independent run restores discovered MCP instructions and refuses a disabled dependency', binding('automation'), async ({ automation, window, model }, info) => {
  const service = await startAcceptanceMcp()
  let page = window
  let phase: string = 'discover'
  const scenario = createToolDiscoveryScenario('automation', (request, answer) => {
    const id = `report-${phase}`
    if (!request.toolResults.some(result => result.id === id)) return { tools: [modelTool(request, 'report_to_user', { type: 'run_complete', message: answer }, id)] }
    return { text: answer }
  })
  try {
    const connection = await installService(page, null, service.url)
    const configured = await page.evaluate(({ appId, specId }) => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateSpec({
      appId, specPatch: { requires: { mcps: [{ id: specId }] } },
    }), { appId: automation.appId, specId: connection.specId })
    expect(configured.success).toBe(true)
    model.respond(scenario.respond)
    await openAutomation(page, automation)
    const run = await startAutomation(page, automation.appId)
    await waitForAutomationResult(page, automation.appId, run.runId, 'ok')
    await openAutomationProcess(page, automation.appId, run.runId)
    for (const next of phases) {
      phase = next
      scenario.start(phase)
      if (phase === 'restored') {
        page = await automation.session.restart()
        await openAutomation(page, automation)
        await openAutomationProcess(page, automation.appId, run.runId)
      }
      if (phase === 'disabled') await disableServiceTool(page, connection.id)
      if (phase !== 'discover') {
        const composer = page.getByPlaceholder('Reply to continue this run...', { exact: true })
        await composer.fill(`Use the receipt service for automation-${phase}.`)
        await composer.press('Enter')
      }
      const answer = `Channel operation recorded: automation-${phase}.`
      await expect(page.locator('.message-assistant [data-message-content]').filter({ hasText: answer })).toBeVisible()
      await waitForAutomationResult(page, automation.appId, run.runId, 'ok')
      assertTurn(scenario, 'automation', phase, 1)
      expect((await readAutomationTranscript(page, automation.appId, run.runId)).some(message => message.role === 'assistant' && message.content.includes(answer))).toBe(true)
    }
    expect(service.calls).toEqual(phases.slice(0, 3).map(phase => ({ value: `automation-${phase}`, failed: false })))
    await info.attach('automation-discovery', { body: JSON.stringify({ requests: [...scenario.requests], results: [...scenario.results], calls: service.calls }), contentType: 'application/json' })
  } finally { await service.close() }
})

test('a team member restores its deferred tool context without reviving a disabled MCP tool', binding('team-member'), async ({ acceptanceApp, window, model }, info) => {
  const service = await startAcceptanceMcp()
  const scenario = createToolDiscoveryScenario('team-member')
  let page = window
  try {
    const space = await seedManagedSpace(page, 'Team discovery workspace')
    const connection = await installService(page, space.id, service.url)
    const coordinator = await installTeammate(page, space.id, 'Discovery coordinator', 'Wait for an explicit task.')
    const worker = await installTeammate(page, space.id, 'Receipt worker', 'Use only the isolated receipt service requested by the owner.')
    const team = await createAwareTeam(page, { spaceId: space.id, name: 'Receipt team', askerAppId: coordinator,
      askerRole: 'Coordinator', teammateAppId: worker, teammateRole: 'Receipt reader', intendedLabel: 'Receipt work', unrelatedLabel: 'Unrelated work' })
    model.respond(scenario.respond)
    for (const phase of phases) {
      scenario.start(phase)
      if (phase === 'restored') page = await acceptanceApp.restart()
      if (phase === 'disabled') await disableServiceTool(page, connection.id)
      const sent = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.teamSendToMember(input), {
        teamId: team.team.id, appId: worker, epochId: team.intended.epochId, spaceId: space.id,
        message: `Use the receipt service for team-member-${phase}.`,
      })
      expect(sent.success).toBe(true)
      await expect.poll(async () => (await memberTranscript(page, { appId: worker, spaceId: space.id, teamId: team.team.id, epochId: team.intended.epochId }))
        .some(message => message.role === 'assistant' && message.content.includes(`Channel operation recorded: team-member-${phase}.`)), { timeout: 45000 }).toBe(true)
      assertTurn(scenario, 'team-member', phase)
      expect(await memberTranscript(page, { appId: worker, spaceId: space.id, teamId: team.team.id, epochId: team.unrelated.epochId })).toEqual([])
    }
    expect(service.calls).toEqual(phases.slice(0, 3).map(phase => ({ value: `team-member-${phase}`, failed: false })))
    await info.attach('team-member-discovery', { body: JSON.stringify({ requests: [...scenario.requests], results: [...scenario.results], calls: service.calls }), contentType: 'application/json' })
  } finally { await service.close() }
})

test('a hosted collaborator discovers independently and follows current MCP restrictions', binding('collaborator'), async ({ acceptanceApp, window, model }, info) => {
  const service = await startAcceptanceMcp()
  let page = window
  let phase = 'discover'
  let target: string | undefined
  let created: CollaboratorReceipt | undefined
  const parentRequests = new Map<string, ModelRequest[]>()
  const childRequests = new Map<string, ModelRequest[]>()
  const receipts = new Map<string, string>()
  const issues: string[] = []
  const assignment = 'HOSTED_MCP_MEMBER: obtain one isolated receipt and report CHILD_RECEIPT_READY.'
  try {
    const space = await seedManagedSpace(page, 'Collaborator discovery workspace')
    const connection = await installService(page, space.id, service.url)
    const conversation = await seedManagedConversation(page, space.id, 'Independent collaborator receipts', [])
    model.respond(request => {
      const child = initialUserInput(request).includes('HOSTED_MCP_MEMBER:')
      const requests = child ? childRequests : parentRequests
      const turn = requests.get(phase) ?? []
      turn.push(request)
      requests.set(phase, turn)
      const result = (id: string) => request.toolResults.find(item => item.id === id)
      if (child) {
        if (phase === 'disabled') {
          const refused = result('child-disabled')
          if (refused) { receipts.set('disabled', refused.text); return { text: 'CHILD_DISABLED_REFUSED' } }
          return { tools: [{ id: 'child-disabled', name: 'CallTool', input: { tool: target!, arguments: '{"value":"child-disabled"}' } }] }
        }
        if (result('child-first')) return { text: 'CHILD_RECEIPT_READY' }
        const next = planModelTool(request, 'echo_acceptance', { value: 'child-first' }, 'child-first')
        if ('call' in next) {
          if (next.call.name === 'CallTool') target = String(next.call.input.tool)
          return { tools: [next.call] }
        }
        issues.push(next.error)
        return { text: 'The collaborator did not receive its definition.' }
      }
      if (phase === 'restored') {
        const restored = result('parent-restored')
        if (restored) { receipts.set('restored', restored.text); return { text: 'Restored parent receipt recorded.' } }
        return { tools: [{ id: 'parent-restored', name: 'CallTool', input: { tool: target!, arguments: '{"value":"parent-restored"}' } }] }
      }
      if (phase === 'disabled') {
        if (!result('send-disable')) return { tools: [modelTool(request, 'team_send', { to: created!.handle, message: 'HOSTED_DISABLE_CHECK: try the receipt tool after it was disabled.' }, 'send-disable')] }
        return { text: request.text.includes('CHILD_DISABLED_REFUSED') ? 'The disabled dependency stayed unavailable.' : 'The collaborator is checking the restriction.' }
      }
      const spawned = result('spawn-reader')
      if (!spawned && !created) return { tools: [modelTool(request, 'spawn_agent', { name: 'Receipt reader', prompt: assignment }, 'spawn-reader')] }
      if (spawned && !created) {
        try { created = collaboratorReceipt(spawned) } catch (error) { issues.push(String(error)) }
      }
      if (!target || !request.text.includes('CHILD_RECEIPT_READY')) return { text: 'The collaborator is reading its receipt.' }
      const guessed = result('parent-before-discovery')
      if (!guessed) return { tools: [{ id: 'parent-before-discovery', name: 'CallTool', input: { tool: target, arguments: '{"value":"parent-before-discovery"}' } }] }
      receipts.set('parent-before-discovery', guessed.text)
      if (result('parent-first')) return { text: 'Parent and collaborator receipts recorded.' }
      const next = planModelTool(request, 'echo_acceptance', { value: 'parent-first' }, 'parent-first')
      if ('call' in next) return { tools: [next.call] }
      issues.push(next.error)
      return { text: 'The parent did not receive its definition.' }
    })
    const answers: Record<string, string> = { discover: 'Parent and collaborator receipts recorded.', restored: 'Restored parent receipt recorded.', disabled: 'The disabled dependency stayed unavailable.' }
    for (const next of ['discover', 'restored', 'disabled']) {
      phase = next
      if (phase === 'restored') page = await acceptanceApp.restart()
      if (phase === 'disabled') await disableServiceTool(page, connection.id)
      await openManagedConversation(page, conversation.title, space.id, { empty: phase === 'discover' })
      const turn = await sendAcceptanceMessage(page, `Check independent collaborator discovery: ${phase}.`)
      expect(turn.conversationId).toBe(conversation.id)
      await expect(page.locator('.message-assistant').last()).toContainText(answers[phase], { timeout: 45000 })
      await waitForAcceptanceIdle(page, conversation.id)
      expect(issues).toEqual([])
    }
    const child = childRequests.get('discover')!
    const parent = parentRequests.get('discover')!
    expect(created?.handle).toBeTruthy()
    for (const requests of [parent, child]) {
      expect(requests[0].tools).toEqual(expect.arrayContaining(['ToolSearch', 'CallTool']))
      expect(requests[0].tools).not.toContain('Agent')
      expect(requests[0].tools.some(name => name.endsWith('__echo_acceptance'))).toBe(false)
      expect(requests[0].text).not.toContain('Return the supplied acceptance value.')
      for (const request of requests) expect(request.body.tools).toEqual(requests[0].body.tools)
    }
    expect(child.some(item => item.text.includes('Return the supplied acceptance value.'))).toBe(true)
    expect(receipts.get('parent-before-discovery')).toMatch(/discover|search/i)
    expect(parentRequests.get('restored')![0].text).toContain('Return the supplied acceptance value.')
    expect(receipts.get('restored')).toContain('Service receipt: parent-restored')
    expect(receipts.get('disabled')).toMatch(/unavailable|not available|not found|not registered|not discovered|disabled|search/i)
    expect(service.calls).toEqual(['child-first', 'parent-first', 'parent-restored'].map(value => ({ value, failed: false })))
    await info.attach('application-collaborator-discovery', { body: JSON.stringify({ created, parent: [...parentRequests], child: [...childRequests], receipts: [...receipts], calls: service.calls }), contentType: 'application/json' })
  } finally { await service.close() }
})
