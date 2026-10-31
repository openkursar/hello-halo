import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { modelTool } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'
import type { HaloAPI } from '../../../src/preload'

test('requesting a disabled capability leaves it off until the user enables it for the next turn', acceptance('chat.capabilities.user-enable'), async ({ model, window }) => {
  test.setTimeout(90000)
  let requested = false
  let listed = false
  model.respond(request => {
    if (request.lastUserText.includes('Show me the teams available in this workspace.')) {
      expect(request.tools.some(name => name.endsWith('__team_list'))).toBe(false)
      expect(request.tools.some(name => name.endsWith('__collab_start'))).toBe(false)
      const receipt = request.toolResults.find(result => result.id === 'ask-for-team-capability')
      if (!receipt) return { tools: [modelTool(request, 'request_toolset', { name: 'halo-team' }, 'ask-for-team-capability')] }
      expect(receipt.text).toContain('Asked the user to enable')
      requested = true
      return { text: 'Turn on the highlighted Team Collaboration switch to list your teams.' }
    }
    if (request.lastUserText.includes('The capability is enabled. List my teams now.')) {
      const result = request.toolResults.find(result => result.id === 'list-enabled-teams')
      if (!result) return { tools: [modelTool(request, 'team_list', {}, 'list-enabled-teams')] }
      expect(result.text).toBe('No saved teams exist in this space yet.')
      listed = true
      return { text: 'There are no saved teams in this workspace yet.' }
    }
    throw new Error(`Unexpected capability request ${request.sequence}`)
  })
  await navigateToChat(window)
  await window.getByRole('button', { name: 'Add files, context and capabilities', exact: true }).click()
  const switchRow = window.getByRole('menuitemcheckbox', { name: /Team Collaboration/ })
  await expect(switchRow).toHaveAttribute('aria-checked', /^(true|false)$/)
  if (await switchRow.getAttribute('aria-checked') === 'true') await switchRow.click()
  await expect(switchRow).toHaveAttribute('aria-checked', 'false')
  await window.keyboard.press('Escape')
  const first = await sendAcceptanceMessage(window, 'Show me the teams available in this workspace.')
  await expect(window.locator('.message-assistant').last()).toContainText('Turn on the highlighted Team Collaboration switch')
  await waitForAcceptanceIdle(window, first.conversationId)
  expect(requested).toBe(true)
  await expect(switchRow).toBeVisible()
  await expect(switchRow).toHaveAttribute('aria-checked', 'false')
  const before = await window.evaluate(async () => (globalThis as unknown as { halo: HaloAPI }).halo.teamList('halo-temp'))
  expect(before).toMatchObject({ success: true, data: [] })
  await switchRow.click()
  await expect(switchRow).toHaveAttribute('aria-checked', 'true')
  await window.keyboard.press('Escape')
  const next = await sendAcceptanceMessage(window, 'The capability is enabled. List my teams now.')
  expect(next.conversationId).toBe(first.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText('There are no saved teams in this workspace yet.')
  await waitForAcceptanceIdle(window, next.conversationId)
  expect(listed).toBe(true)
})
