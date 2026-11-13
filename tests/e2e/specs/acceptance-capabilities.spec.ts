import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { replyWithModelTool } from '../fixtures/acceptance-tool-discovery'
import { collaboratorReceipt, hasRetiredDailyTeamTool, type CollaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { seedManagedSpace } from '../fixtures/acceptance-management'
import { navigateToChat } from '../fixtures/helpers'
import { initialUserInput, type ModelRequest, type ModelReply } from '../fixtures/acceptance-model'
import { test as browserTest, snapshotUid } from '../fixtures/acceptance-browser-work'

const menuButton = 'Add files, context and capabilities'

type CapabilityStep = { name: string; input: Record<string, unknown> | ((request: ModelRequest) => Record<string, unknown>) }

function capabilityScript(steps: CapabilityStep[]) {
  const requests: ModelRequest[] = []
  const issues: string[] = []
  return {
    requests, issues,
    respond(request: ModelRequest): ModelReply {
      requests.push(request)
      for (const [index, step] of steps.entries()) {
        if (request.toolResults.some(result => result.id === `capability-${index}`)) continue
        try {
          return replyWithModelTool(request, step.name, typeof step.input === 'function' ? step.input(request) : step.input, `capability-${index}`, issues)
        } catch (error) {
          issues.push(String(error))
          return { text: 'Capability script stopped.' }
        }
      }
      return { text: 'The bounded capability task is complete.' }
    },
  }
}

function capabilityResult(request: ModelRequest, index: number): string {
  const result = request.toolResults.find(item => item.id === `capability-${index}`)
  if (!result || result.error) throw new Error(`Missing successful capability result ${index}: ${result?.text}`)
  return result.text
}

function assertDeferredCapabilities(request: ModelRequest) {
  expect(request.tools.some(name => /__(?:browser|terminal)_/.test(name))).toBe(false)
  expect(request.tools).toEqual(expect.arrayContaining(['ToolSearch', 'CallTool']))
  expect(request.text).toContain('ai-browser')
  expect(request.text).toContain('ai-terminal')
  const wire = JSON.stringify(request.body)
  expect(wire).not.toContain('## AI Terminal')
  expect(wire).not.toContain('### Core Workflow')
  expect(request.tools.some(name => name.endsWith('__read_halo_doc'))).toBe(true)
  expect(request.tools.some(name => name.endsWith('__halo_api_ref'))).toBe(true)
  expect(request.tools.some(name => name.endsWith('__spawn_agent'))).toBe(true)
}

function assertStableDiscovery(requests: ModelRequest[], service: string) {
  assertDeferredCapabilities(requests[0])
  for (const request of requests) {
    expect(request.body.tools).toEqual(requests[0].body.tools)
    expect(request.body.system).toEqual(requests[0].body.system)
  }
  const final = requests.at(-1)!
  const definitions = final.toolResults.flatMap(result => {
    try { return JSON.parse(result.text).tools ?? [] } catch { return [] }
  }) as Array<{ name: string; version?: string; already_loaded?: boolean; description?: string; input_schema?: unknown; usage_guide?: string }>
  const discovered = definitions.filter(tool => tool.name.includes(`__${service}__`))
  expect(discovered.length).toBeGreaterThan(0)
  expect(discovered.filter(tool => tool.usage_guide)).toHaveLength(1)
  expect(discovered.find(tool => tool.usage_guide)?.usage_guide!.length).toBeGreaterThan(100)
  const complete = new Map<string, string>()
  for (const definition of discovered) {
    expect(definition.version).toBeTruthy()
    if (definition.already_loaded) {
      expect(complete.get(definition.name)).toBe(definition.version)
      expect(definition.usage_guide).toBeUndefined()
    } else {
      expect(definition.description).toBeTruthy()
      expect(definition.input_schema).toBeTruthy()
      complete.set(definition.name, definition.version!)
    }
  }
}

async function assertAutomaticCapabilities(window: import('@playwright/test').Page) {
  await window.getByRole('button', { name: menuButton, exact: true }).click()
  for (const name of [/Operate Halo/, /Team Collaboration/, /Web Control/, /^AI Terminal\b/, /Text Extraction/]) {
    await expect(window.getByRole('menuitemcheckbox', { name })).toHaveCount(0)
  }
  await window.keyboard.press('Escape')
}

test('ordinary conversation omits browser and terminal definitions and long guides', acceptance('chat.capabilities.ordinary-context'), async ({ model, window }, info) => {
  const requests: ModelRequest[] = []
  model.respond(request => { requests.push(request); return { text: 'Four.' } })
  await navigateToChat(window)
  const turn = await sendAcceptanceMessage(window, 'What is two plus two?')
  await expect(window.locator('.message-assistant').last()).toContainText('Four.')
  await waitForAcceptanceIdle(window, turn.conversationId)
  expect(requests).toHaveLength(1)
  assertDeferredCapabilities(requests[0])
  expect(requests[0].text.split('Use collaborators when work can progress independently, benefits from a separate context, or needs independent review.').length - 1).toBe(1)
  expect(model.exchanges.flatMap(exchange => exchange.reply?.tools ?? [])).toEqual([])
  await info.attach('ordinary-capability-request', { body: JSON.stringify(requests, null, 2), contentType: 'application/json' })
})

browserTest('browser discovers full usage before navigation and reuses fixed declarations', acceptance('chat.capabilities.browser-discovery'), async ({ model, window, browserWorkSite }, info) => {
  browserTest.setTimeout(120000)
  const script = capabilityScript([
    { name: 'browser_navigate', input: { url: browserWorkSite.targetUrl } },
    { name: 'browser_snapshot', input: {} },
    { name: 'browser_fill', input: request => ({ uid: snapshotUid(capabilityResult(request, 1), 'textbox', 'Draft'), value: 'Deferred browser marker' }) },
    { name: 'browser_snapshot', input: {} },
    { name: 'browser_fill', input: request => ({ uid: snapshotUid(capabilityResult(request, 3), 'textbox', 'Draft'), value: 'Repeated browser marker' }) },
    { name: 'browser_snapshot', input: {} },
  ])
  model.respond(script.respond)
  await navigateToChat(window)
  await assertAutomaticCapabilities(window)
  const turn = await sendAcceptanceMessage(window, `Open ${browserWorkSite.targetUrl}, fill Draft, then replace it and verify each result.`)
  await expect(window.locator('.message-assistant').last()).toContainText('The bounded capability task is complete.', { timeout: 90000 })
  await waitForAcceptanceIdle(window, turn.conversationId)
  expect(script.issues).toEqual([])
  assertStableDiscovery(script.requests, 'ai-browser')
  const beforeNavigation = script.requests.find(request => request.toolResults.some(result => result.id === 'capability-0-search'))!
  expect(beforeNavigation).toBeTruthy()
  expect(beforeNavigation.toolResults.find(result => result.id === 'capability-0-search')?.text).toContain('usage_guide')
  expect(capabilityResult(script.requests.at(-1)!, 3)).toContain('Deferred browser marker')
  expect(capabilityResult(script.requests.at(-1)!, 5)).toContain('Repeated browser marker')
  expect(model.exchanges.flatMap(exchange => exchange.reply?.tools ?? []).some(tool => tool.name.endsWith('__request_toolset'))).toBe(false)
  await info.attach('browser-discovery-requests', { body: JSON.stringify({ requests: script.requests, exchanges: model.exchanges }, null, 2), contentType: 'application/json' })
})

test('terminal discovers full usage and closes only its own pty', acceptance('chat.capabilities.terminal-discovery'), async ({ model, window }, info) => {
  test.setTimeout(120000)
  const session = (request: ModelRequest) => {
    const id = capabilityResult(request, 0).match(/\(id: ([^)]+)\)/)?.[1]
    if (!id) throw new Error('The actual terminal creation returned no session id')
    return id
  }
  const script = capabilityScript([
    { name: 'terminal_create', input: { title: 'Isolated deferred terminal' } },
    { name: 'terminal_write', input: request => ({ session: session(request), input: "printf 'DEFERRED_PTY_MARKER\\n'", timeout: 5 }) },
    { name: 'terminal_read', input: request => ({ session: session(request), mode: 'screen' }) },
    { name: 'terminal_kill', input: request => ({ session: session(request) }) },
    { name: 'terminal_list', input: {} },
  ])
  model.respond(script.respond)
  await navigateToChat(window)
  await assertAutomaticCapabilities(window)
  const turn = await sendAcceptanceMessage(window, 'Create a temporary interactive terminal, print DEFERRED_PTY_MARKER, read its screen, and close only that terminal.')
  await expect(window.locator('.message-assistant').last()).toContainText('The bounded capability task is complete.', { timeout: 90000 })
  await waitForAcceptanceIdle(window, turn.conversationId)
  expect(script.issues).toEqual([])
  assertStableDiscovery(script.requests, 'ai-terminal')
  const final = script.requests.at(-1)!
  expect(capabilityResult(final, 1)).toContain('DEFERRED_PTY_MARKER')
  expect(capabilityResult(final, 2)).toContain('DEFERRED_PTY_MARKER')
  expect(capabilityResult(final, 3)).toContain(`Killed session ${session(final)}`)
  await expect.poll(async () => {
    const response = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.listTerminals())
    expect(response.success).toBe(true)
    return JSON.stringify(response.data)
  }).not.toContain(session(final))
  expect(model.exchanges.flatMap(exchange => exchange.reply?.tools ?? []).some(tool => tool.name.endsWith('__request_toolset'))).toBe(false)
  await info.attach('terminal-discovery-requests', { body: JSON.stringify({ requests: script.requests, exchanges: model.exchanges }, null, 2), contentType: 'application/json' })
})

test('a conversation creates a collaborator without a capability enablement request', acceptance('chat.capabilities.automatic'), async ({ model, window }, info) => {
  test.setTimeout(120000)
  const requests: ModelRequest[] = []
  const issues: string[] = []
  let created: CollaboratorReceipt | undefined
  let childStarted = false
  const assignment = 'CAPABILITY_BETA_CHECK: Verify that beta follows alpha.'
  model.respond(request => {
    requests.push(request)
    if (hasRetiredDailyTeamTool(request)) issues.push('A retired collaboration tool was advertised.')
    if (initialUserInput(request).includes(assignment)) { childStarted = true; return { text: 'Beta follows alpha.' } }
    const result = request.toolResults.find(item => item.id === 'automatic-collaborator')
    if (result) {
      try { created = collaboratorReceipt(result) } catch (error) { issues.push(String(error)) }
      return { text: 'The collaborator accepted the beta check.' }
    }
    return replyWithModelTool(request, 'spawn_agent', { prompt: assignment }, 'automatic-collaborator', issues)
  })
  await navigateToChat(window)
  await assertAutomaticCapabilities(window)
  const turn = await sendAcceptanceMessage(window, 'Ask a collaborator to check item beta.')
  await expect(window.locator('.message-assistant').last()).toContainText('The collaborator accepted the beta check.')
  await waitForAcceptanceIdle(window, turn.conversationId)
  await expect.poll(() => childStarted).toBe(true)
  expect(issues).toEqual([])
  expect(created?.handle).toBeTruthy()
  const association = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), turn.conversationId)
  expect(association).toMatchObject({ success: true, data: { active: true } })
  expect(model.exchanges.flatMap(exchange => exchange.reply?.tools ?? []).some(tool => tool.name.endsWith('__request_toolset'))).toBe(false)
  await info.attach('automatic-capability-turn', { body: JSON.stringify({ turn, created, requests }, null, 2), contentType: 'application/json' })
})

test('Halo API is a core capability with usable scoped credentials from the first turn', acceptance('chat.capabilities.halo-api-core'), async ({ model, window }, info) => {
  test.setTimeout(120000)
  const space = await seedManagedSpace(window, 'Core API workspace')
  const requests: ModelRequest[] = []
  const issues: string[] = []
  model.respond(request => {
    requests.push(request)
    const inspected = request.toolResults.find(item => item.id === 'inspect-core-api')
    if (!inspected) return replyWithModelTool(request, 'Bash', {
      command: 'if [ -n "$HALO_API_TOKEN" ] && [ -n "$HALO_API_URL" ]; then printf api-ready; else printf api-absent; fi',
    }, 'inspect-core-api', issues)
    const guide = request.toolResults.find(item => item.id === 'read-api-guide')
    if (!guide) return replyWithModelTool(request, 'halo_api_ref', { group: 'workspace' }, 'read-api-guide', issues)
    const read = request.toolResults.find(item => item.id === 'use-core-api')
    if (!read) return replyWithModelTool(request, 'Bash', {
      command: 'curl --fail --silent --show-error -H "Authorization: Bearer $HALO_API_TOKEN" "$HALO_API_URL/api/spaces"',
    }, 'use-core-api', issues)
    return { text: 'The core Halo API returned the workspace list.' }
  })
  await navigateToChat(window)
  await assertAutomaticCapabilities(window)
  const turn = await sendAcceptanceMessage(window, 'Use Halo API to list my workspaces.')
  await expect(window.locator('.message-assistant').last()).toContainText('The core Halo API returned the workspace list.')
  await waitForAcceptanceIdle(window, turn.conversationId)
  expect(issues).toEqual([])
  expect(requests[0].tools.some(name => name.endsWith('__halo_api_ref'))).toBe(true)
  expect(requests.at(-1)!.toolResults.find(item => item.id === 'inspect-core-api')?.text).toContain('api-ready')
  expect(requests.at(-1)!.toolResults.find(item => item.id === 'read-api-guide')?.text).toContain('/api/spaces')
  const listed = JSON.parse(requests.at(-1)!.toolResults.find(item => item.id === 'use-core-api')!.text)
  expect(listed).toMatchObject({ success: true, data: expect.arrayContaining([expect.objectContaining({ id: space.id, name: space.name })]) })
  expect(model.exchanges.flatMap(exchange => exchange.reply?.tools ?? []).some(tool => tool.name.endsWith('__request_toolset'))).toBe(false)
  await info.attach('core-api-turn', { body: JSON.stringify({ turn, requests }, null, 2), contentType: 'application/json' })
})
