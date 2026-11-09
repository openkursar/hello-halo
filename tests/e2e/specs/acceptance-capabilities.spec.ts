import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { replyWithModelTool } from '../fixtures/acceptance-tool-discovery'
import { collaboratorReceipt, hasRetiredDailyTeamTool, type CollaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { seedManagedSpace } from '../fixtures/acceptance-management'
import { navigateToChat } from '../fixtures/helpers'
import { initialUserInput, type ModelRequest } from '../fixtures/acceptance-model'

const menuButton = 'Add files, context and capabilities'

async function assertAutomaticCapabilities(window: import('@playwright/test').Page) {
  await window.getByRole('button', { name: menuButton, exact: true }).click()
  for (const name of [/Operate Halo/, /Team Collaboration/, /Web Control/, /^AI Terminal\b/, /Text Extraction/]) {
    await expect(window.getByRole('menuitemcheckbox', { name })).toHaveCount(0)
  }
  await window.keyboard.press('Escape')
}

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
