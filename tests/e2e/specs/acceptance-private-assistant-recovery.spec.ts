import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { buildTeamSessionKey } from '../../../src/shared/apps/im-keys'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import { collaboratorReceipt, type CollaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { initialUserInput, latestUserInput, type ModelRequest } from '../fixtures/acceptance-model'
import { assignmentTool } from '../fixtures/acceptance-subagent-wire'
import { createAwareTeam, installTeammate, memberTranscript, systemOf } from '../fixtures/acceptance-team-awareness'

const spaceId = 'halo-temp'
const parentIdentity = 'PRIVATE_RECOVERY_COORDINATOR'
const peerIdentity = 'PRIVATE_RECOVERY_TEAMMATE'
const start = 'PRIVATE_RECOVERY_START: Ask your private assistant to keep the evidence.'
const brief = 'PRIVATE_RECOVERY_BRIEF: Keep the synthetic reference amber-218 in your own history.'
const summary = 'Keep the original assignment and continue the private assistant by its ID:'
const resume = 'PRIVATE_RECOVERY_CONTINUE: Ask the original private assistant for its reference.'
const probe = 'PRIVATE_RECOVERY_PROBE: Return the reference you kept.'
const recoveredReply = 'Original private reference after compaction: amber-218.'
const originalFollowup = 'PRIVATE_RECOVERY_BY_ID: Continue the original assignment.'

test.use({ sdkEngine: 'halo', aiSource: async ({ model }, use) => {
  const modelId = 'claude-sonnet-4-5-20250929'
  const source = { provider: 'anthropic', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: modelId,
    modelOverrides: { [modelId]: { contextWindow: 128_000, maxOutputTokens: 4_096 } } }
  await use(source)
} })

interface Member {
  appId: string
  teamId: string
  epochId: string
  spaceId: string
}

async function send(page: Page, member: Member, message: string) {
  const result = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.teamSendToMember(input), { ...member, message })
  expect(result.success, result.error).toBe(true)
  expect(result.data).toMatchObject({ ok: true })
}

async function waitForReply(page: Page, member: Member, reply: string) {
  await expect.poll(async () => (await memberTranscript(page, member)).some(
    message => message.role === 'assistant' && message.content.includes(reply)), { timeout: 30000 }).toBe(true)
  await expect.poll(() => page.evaluate(async ({ appId, conversationId }) => {
    const state = await (globalThis as unknown as { halo: HaloAPI }).halo.appChatSessionState(appId, conversationId)
    return state.success ? (state.data as { isActive: boolean } | undefined)?.isActive : undefined
  }, { appId: member.appId, conversationId: buildTeamSessionKey(member.appId, member.teamId, member.epochId) }), { timeout: 15000 }).toBe(false)
}

test('the original private assistant remains reachable by ID after compaction despite a same-named teammate', acceptance('teams.collaboration.private-recovery-addressing'), async ({ window, model }, info) => {
  test.setTimeout(150000)
  let receipt: CollaboratorReceipt | undefined
  let continued: ModelRequest | undefined
  let helperReceived = false
  let summaries = 0
  const errors: string[] = []
  model.respond(request => {
    const input = latestUserInput(request)
    const reply = (text: string) => ({ text })
    if (request.lastUserText.startsWith('Prepare a compact handover for another assistant continuing the same task.') || request.lastUserText.includes('<conversation_to_summarize')) {
      summaries++
      const handle = receipt?.handle
      if (!handle || !request.text.includes(handle)) {
        errors.push('The compaction request did not include the original private assistant ID.')
        return reply('The private assistant ID was unavailable.')
      }
      return reply(`${summary} ${handle}`)
    }
    if (systemOf(request).includes(peerIdentity)) return reply('The teammate received its request.')
    if (initialUserInput(request).includes(brief)) {
      if (input.includes(probe)) {
        helperReceived = true
        return reply(recoveredReply)
      }
      return reply(input.includes(originalFollowup) ? 'Original private reference: amber-218.' : 'The private reference is recorded.')
    }
    if (!systemOf(request).includes(parentIdentity)) { errors.push(`Unexpected request ${request.sequence}`); return reply('No assignment matched.') }
    if (input.includes(start)) {
      const created = request.toolResults.find(result => result.id === 'create-private')
      if (!created) return assignmentTool(request, 'spawn_agent', { name: 'Tester', prompt: brief }, 'create-private')
      try { receipt ??= collaboratorReceipt(created) }
      catch (error) { errors.push(String(error)); return reply('Creation failed.') }
      const result = request.toolResults.find(result => result.id === 'continue-by-id')
      if (!result) return assignmentTool(request, 'team_send', { to: receipt.handle, message: originalFollowup }, 'continue-by-id')
      if (result.error) errors.push(result.text)
      return reply('The original assistant was contacted by its ID.')
    }
    if (input.startsWith('PRIVATE_RECOVERY_HISTORY_')) return reply(`Recorded ${input.split(':')[0]}.`)
    if (!input.includes(resume)) return reply('Waiting for the next request.')
    const address = request.text.split(`${summary} `)[1]?.match(/^\S+/)?.[0]
    if (!address) { errors.push('The compacted summary did not retain the private assistant ID.'); return reply('No private assistant ID was recovered.') }
    continued ??= request
    const result = request.toolResults.find(result => result.id === 'private-followup-after-summary')
    if (!result) return assignmentTool(request, 'team_send', { to: address, message: probe }, 'private-followup-after-summary')
    if (result.error) errors.push(result.text)
    return reply('The private follow-up was sent by ID.')
  })

  await expect.poll(() => window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.teamList().then(result => result.success))).toBe(true)
  const parentId = await installTeammate(window, spaceId, 'Coordinator', `Only act on the current assignment. ${parentIdentity}`)
  const peerId = await installTeammate(window, spaceId, 'Tester', `Only act on the current assignment. ${peerIdentity}`)
  const { team, intended } = await createAwareTeam(window, { spaceId, name: 'Private recovery isolation', askerAppId: parentId, askerRole: 'Coordinator',
    teammateAppId: peerId, teammateRole: 'Tester', intendedLabel: 'Original private request', unrelatedLabel: 'Unrelated work' })
  const task = { teamId: team.id, epochId: intended.epochId, spaceId }
  const parent = { ...task, appId: parentId }
  const peer = { ...task, appId: peerId }
  await send(window, parent, start + '\n' + 'Earlier evidence is read-only. '.repeat(1700))
  await waitForReply(window, parent, 'The original assistant was contacted by its ID.')
  expect(receipt).toMatchObject({ name: 'Tester', handle: expect.any(String) })
  expect(receipt!.handle).not.toBe('Tester')
  const scope = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), buildTeamSessionKey(parentId, team.id, intended.epochId))
  expect(scope.success).toBe(true)
  const privateWork = scope.data as { teamId: string; epochId: string }
  const helper = { ...privateWork, spaceId, appId: receipt!.handle }
  await waitForReply(window, helper, 'Original private reference: amber-218.')
  for (let index = 0; index < 6; index++) {
    await send(window, parent, `PRIVATE_RECOVERY_HISTORY_${index}: Keep the existing work.\n${'Earlier evidence is read-only. '.repeat(450)}`)
    await waitForReply(window, parent, `Recorded PRIVATE_RECOVERY_HISTORY_${index}.`)
  }
  await send(window, parent, '/compact')
  await expect.poll(() => summaries, { timeout: 15000 }).toBeGreaterThan(0)
  await send(window, parent, resume)
  await waitForReply(window, parent, 'The private follow-up was sent by ID.')
  expect(errors).toEqual([])
  expect(continued?.text).toContain(`${summary} ${receipt!.handle}`)
  expect(continued?.toolResults.some(result => result.id === 'create-private')).toBe(false)
  const result = model.exchanges.flatMap(exchange => exchange.request.toolResults).find(item => item.id === 'private-followup-after-summary')
  expect(result).toMatchObject({ error: false })
  await waitForReply(window, helper, recoveredReply)
  const teammateReceived = (await memberTranscript(window, peer)).some(message => message.content.includes(probe))
  await info.attach('private-recovery-routing', { body: JSON.stringify({ name: receipt!.name, helperReceived, teammateReceived }), contentType: 'application/json' })
  expect(helperReceived).toBe(true)
  expect(teammateReceived).toBe(false)
})
