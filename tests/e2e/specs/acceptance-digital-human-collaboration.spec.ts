import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { getAppChatConversationId } from '../../../src/shared/apps/im-keys'
import { test, expect, acceptance } from '../fixtures/acceptance-automation'
import { modelTool, type ModelRequest } from '../fixtures/acceptance-model'

test.setTimeout(180000)

const startMessage = 'Organize a temporary team: one checker verifies item alpha and reports back to me here.'
const dispatch = 'Check item alpha and report the result to the coordinator.'
const memberResult = 'alpha-checked-417'
const coordinatorReply = `The checker reported ${memberResult}.`

const isCoordinator = (request: ModelRequest) => request.tools.some(tool => tool.endsWith('__collab_start'))

function scriptCollaboration(request: ModelRequest) {
  if (isCoordinator(request)) {
    if (request.lastUserText.includes(memberResult)) return { text: coordinatorReply }
    if (!request.text.includes(startMessage)) throw new Error(`Unexpected coordinator request: ${request.lastUserText.slice(-300)}`)
    const created = request.toolResults.find(result => result.id === 'dh-collab-start')
    if (!created) {
      return { tools: [modelTool(request, 'collab_start', {
        name: 'Alpha check',
        goal: 'Verify item alpha.',
        members: [{ memberName: 'Checker', role: 'Item checker', responsibility: 'Verify the item and report the result.' }],
      }, 'dh-collab-start')] }
    }
    if (created.error || !created.text.includes('is ready')) throw new Error(`Collaboration creation failed: ${created.text}`)
    const sent = request.toolResults.find(result => result.id === 'dh-collab-send')
    if (!sent) return { tools: [modelTool(request, 'team_send', { to: 'Checker', message: dispatch }, 'dh-collab-send')] }
    if (sent.error) throw new Error(`Dispatch failed: ${sent.text}`)
    return { text: 'The checker is working on item alpha.' }
  }
  if (request.text.includes(dispatch)) {
    const reported = request.toolResults.find(result => result.id === 'dh-member-report')
    if (!reported) return { tools: [modelTool(request, 'team_send', { to: 'coordinator', message: memberResult }, 'dh-member-report')] }
    return { text: 'Reported to the coordinator.' }
  }
  throw new Error(`Unexpected model request ${request.sequence}: ${request.lastUserText.slice(-300)}`)
}

const api = (page: Page) => ({
  collabFor: (conversationId: string) => page.evaluate(
    id => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), conversationId),
  messages: (input: { appId: string; spaceId: string; conversationId: string }) => page.evaluate(
    value => (globalThis as unknown as { halo: HaloAPI }).halo.appChatMessages(value), input),
})

test('a digital human\u2019s own chat organizes a temporary team and receives its member\u2019s report there', acceptance('teams.collaboration.digital-human-chat'), async ({ model, automation, window }) => {
  model.respond(scriptCollaboration)
  const person = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGet(id), automation.appId)
  expect(person.success).toBe(true)
  const spaceId = (person.data as { spaceId: string }).spaceId

  const created = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appSessionCreate({ appId }), automation.appId)
  expect(created.success).toBe(true)
  const chat = created.data!.conversationId

  const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSend(input), {
    appId: automation.appId, spaceId, conversationId: chat, message: startMessage,
  })
  expect(sent.success, 'The owner\u2019s message reaches the digital human').toBe(true)

  await expect.poll(async () => (await api(window).collabFor(chat)).data ?? null, { timeout: 60000 })
    .toMatchObject({ name: 'Alpha check', active: true })
  const collab = (await api(window).collabFor(chat)).data as { teamId: string }

  // Conversation collaboration is off by default for a digital human; the report still arrives.
  await expect.poll(async () => {
    const history = await api(window).messages({ appId: automation.appId, spaceId, conversationId: chat })
    const rows = (history.data ?? []) as Array<{ role: string; content: string; source?: string; metadata?: Record<string, unknown> }>
    return {
      report: rows.some(row => row.source === 'team-message' && row.content.includes(memberResult) && row.metadata?.fromMemberName === 'Checker'),
      answered: rows.some(row => row.role === 'assistant' && row.content.includes(coordinatorReply)),
    }
  }, { timeout: 90000 }).toEqual({ report: true, answered: true })

  const defaultChat = getAppChatConversationId(automation.appId)
  expect((await api(window).collabFor(defaultChat)).data ?? null, 'Another chat of the same digital human has no collaboration').toBeNull()

  const deleted = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appSessionDelete(input), {
    appId: automation.appId, spaceId, conversationId: chat,
  })
  expect(deleted.success).toBe(true)
  // A dissolved team reads back as a successful lookup with no data.
  await expect.poll(async () => {
    const detail = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamGetDetail(id), collab.teamId)
    return { success: detail.success, team: detail.data ?? null, association: (await api(window).collabFor(chat)).data ?? null }
  }, {
    timeout: 30000, message: 'Deleting the chat dissolves the temporary collaboration it started',
  }).toEqual({ success: true, team: null, association: null })
})
