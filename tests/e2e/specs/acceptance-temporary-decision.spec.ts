import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { ActivityEntry } from '../../../src/shared/apps/app-types'
import type { EpochBoard } from '../../../src/shared/apps/team-types'
import type { TranscriptMessage } from '../../../src/shared/types/transcript'
import { buildTeamSessionKey } from '../../../src/shared/apps/team-types'
import { test, expect, acceptance, sendAcceptanceMessage, readAcceptanceConversation, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { navigateToChat } from '../fixtures/helpers'
import { openManagedConversation } from '../fixtures/acceptance-management'
import { readDecision, pendingDecisions } from '../fixtures/acceptance-decisions'
import { collaboratorReceipt, hasRetiredDailyTeamTool, type CollaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { initialUserInput, latestUserInput, modelTool, type ModelRequest, type ModelReply } from '../fixtures/acceptance-model'

test.setTimeout(180000)

type Scope = { teamId: string; epochId: string; name: string }
type Message = Pick<TranscriptMessage, 'id' | 'role' | 'content' | 'source' | 'metadata'>
const appIds = async (page: Page) => page.evaluate(async () => {
  const result = await (globalThis as unknown as { halo: HaloAPI }).halo.appList({ type: 'automation' })
  if (!result.success) throw new Error(result.error)
  return (result.data as Array<{ id: string }>).map(app => app.id).sort()
})
const board = async (page: Page, scope: Scope) => page.evaluate(async input => {
  const result = await (globalThis as unknown as { halo: HaloAPI }).halo.teamEpochBoard(input)
  if (!result.success || !result.data) throw new Error(result.error ?? 'No original work board')
  return result.data as EpochBoard
}, { teamId: scope.teamId, epochId: scope.epochId })
const history = async (page: Page, scope: Scope, appId: string, spaceId: string) => page.evaluate(async input => {
  const result = await (globalThis as unknown as { halo: HaloAPI }).halo.teamChatMessages(input)
  if (!result.success) throw new Error(result.error)
  return (result.data as Message[]).map(({ id, role, content, source, metadata }) => ({ id, role, content, source, metadata }))
}, { teamId: scope.teamId, epochId: scope.epochId, appId, spaceId })

async function waitForMemberIdle(page: Page, scope: Scope, appId: string) {
  const conversationId = buildTeamSessionKey(appId, scope.teamId, scope.epochId)
  await expect.poll(async () => {
    const result = await page.evaluate(({ appId, conversationId }) =>
      (globalThis as unknown as { halo: HaloAPI }).halo.appChatSessionState(appId, conversationId), { appId, conversationId })
    if (!result.success) throw new Error(result.error)
    return (result.data as { isActive: boolean }).isActive
  }, { timeout: 30000 }).toBe(false)
}

async function openMemberRoom(page: Page, scope: Scope, member: CollaboratorReceipt) {
  const badge = page.getByText(`Team: ${scope.name}`, { exact: true })
  await expect(badge).toHaveCount(1)
  await badge.locator('..').getByRole('button', { name: 'Open team view', exact: true }).click()
  const header = page.getByRole('heading', { name: scope.name, level: 1, exact: true }).locator('xpath=ancestor::header')
  await expect(header).toBeVisible()
  const select = page.getByRole('button', { name: `View ${member.name}’s work in this task`, exact: true })
  if (!await select.isVisible()) await header.getByRole('button', { name: 'Members', exact: true }).click()
  await select.click()
  return page.getByRole('region', { name: 'Task room', exact: true })
}

test('a temporary collaborator asks its owner and continues the same work after a UI answer',
  acceptance('teams.decisions.temporary-member-answer'), async ({ acceptanceApp, model, window }, info) => {
    const nonce = randomUUID()
    const start = `Delegate one release check and ask me for the needed decision. Reference ${nonce}`
    const assignment = `TEMPORARY_DECISION_ASSIGNMENT_${nonce}`
    const contextToken = `member-context-${randomUUID()}`
    const question = `Which release channel should this check use? Reference ${nonce}`
    const answer = `Use the beta channel. Approval ${randomUUID()}`
    const completed = `TEMPORARY_DECISION_DONE_${nonce}`
    const sourceReady = 'The reviewer is waiting for your decision in its task.'
    const sourceDone = 'The same reviewer continued with your beta-channel decision.'
    const askId = 'temporary-decision-ask', sendId = 'temporary-decision-result', spawnId = 'temporary-decision-spawn'
    const failures: string[] = []
    const resumed: Array<{ sequence: number; originalContext: boolean; originalQuestion: boolean; answer: boolean }> = []
    let created: CollaboratorReceipt | undefined
    let spawnCount = 0, askCount = 0
    model.respond((request: ModelRequest): ModelReply => {
      if (hasRetiredDailyTeamTool(request)) failures.push('A retired daily collaboration tool was advertised')
      const initial = initialUserInput(request), current = latestUserInput(request)
      if (initial.includes(assignment)) {
        const sent = request.toolResults.find(result => result.id === sendId)
        if (sent) {
          if (sent.error) failures.push(`Continuation report was refused: ${sent.text}`)
          return { text: `The original reviewer finished: ${completed}` }
        }
        if (current.includes(answer)) {
          resumed.push({ sequence: request.sequence, originalContext: request.text.includes(contextToken),
            originalQuestion: current.includes(question), answer: current.includes(answer) })
          return { tools: [modelTool(request, 'team_send', { to: 'lead', message: `${completed}: ${answer}` }, sendId)] }
        }
        const asked = request.toolResults.find(result => result.id === askId)
        if (asked) {
          if (asked.error) failures.push(`Decision persistence failed: ${asked.text}`)
          return { text: 'Waiting for the owner to answer the saved question.' }
        }
        askCount++
        return { tools: [modelTool(request, 'report_to_user', { type: 'escalation', message: question }, askId)] }
      }
      if (initial.includes(start)) {
        const receipt = request.toolResults.find(result => result.id === spawnId)
        if (!receipt) {
          spawnCount++
          return { tools: [modelTool(request, 'spawn_agent', { name: 'Decision reviewer',
            prompt: `${assignment}. Keep this original context token: ${contextToken}. Ask the owner which release channel to use with report_to_user. After the owner answers, continue this same work and report the result to coordinator.` }, spawnId)] }
        }
        try { created = collaboratorReceipt(receipt) } catch (error) { failures.push(String(error)) }
        return { text: current.includes(completed) ? sourceDone : sourceReady }
      }
      failures.push(`Unknown scripted actor at request ${request.sequence}`)
      return { text: 'No matching decision work was requested.' }
    })

    const installedBefore = await appIds(window)
    await navigateToChat(window)
    const source = await sendAcceptanceMessage(window, start)
    await expect.poll(() => created?.handle, { timeout: 30000 }).toBeTruthy()
    const member = created!
    await expect(window.locator('.message-assistant [data-message-content]').filter({ hasText: sourceReady }).first()).toBeVisible()
    const scope = await window.evaluate(async id => {
      const result = await (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id)
      if (!result.success || !result.data) throw new Error('The source work must exist')
      return result.data as Scope
    }, source.conversationId)
    const sessionKey = buildTeamSessionKey(member.handle, scope.teamId, scope.epochId)
    const decisions = async () => (await pendingDecisions(window, member.handle)).filter(entry => entry.content.summary === question)
    await expect.poll(async () => (await decisions()).length, { timeout: 30000 }).toBe(1)
    const decision: ActivityEntry = (await decisions())[0]
    expect(decision).toMatchObject({ appId: member.handle, sessionKey,
      content: { teamContext: { teamId: scope.teamId, epochId: scope.epochId } } })
    expect(decision.userResponse).toBeUndefined()
    expect(decision.continuation).toBeUndefined()
    expect((await board(window, scope)).members.filter(value => !value.isSystemCoordinator))
      .toEqual([expect.objectContaining({ appId: member.handle, memberName: member.name, isTemporary: true })])
    await waitForMemberIdle(window, scope, member.handle)
    const before = await history(window, scope, member.handle, source.spaceId)
    expect(before.some(message => message.content.includes(contextToken))).toBe(true)
    expect(await appIds(window)).toEqual(installedBefore)
    expect((await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGet(id), member.handle)).data ?? null).toBeNull()

    const room = await openMemberRoom(window, scope, member)
    const card = room.locator(`[id="decision-${decision.id}"]`)
    await expect(card).toHaveCount(1)
    await expect(card.getByRole('textbox', { name: question, exact: true })).toBeVisible()
    const submit = card.getByRole('button', { name: 'Submit and continue this work', exact: true })
    await expect(submit).toBeDisabled()
    await card.getByRole('textbox', { name: question, exact: true }).fill(answer)
    await submit.click()
    await expect.poll(async () => (await readDecision(window, member.handle, decision.id)).continuation?.status,
      { timeout: 45000 }).toBe('completed')
    await expect(card.getByText('Answered', { exact: true })).toBeVisible()
    await expect(card).toContainText(answer)
    await expect(card.getByRole('button', { name: 'Submit and continue this work', exact: true })).toHaveCount(0)
    const stored = await readDecision(window, member.handle, decision.id)
    expect(stored).toMatchObject({ appId: member.handle, sessionKey, userResponse: { text: answer }, continuation: { status: 'completed', attempts: 1 } })
    expect(resumed).toEqual([expect.objectContaining({ originalContext: true, originalQuestion: true, answer: true })])
    expect(await pendingDecisions(window, member.handle)).toEqual([])
    expect((await board(window, scope)).epoch).toMatchObject({ id: scope.epochId, endedAt: null })
    await waitForMemberIdle(window, scope, member.handle)
    const after = await history(window, scope, member.handle, source.spaceId)
    await info.attach('temporary-decision-answer-history', { contentType: 'application/json',
      body: JSON.stringify({ scope, member, decision: stored, before, after }, null, 2) })
    expect(after.slice(0, before.length)).toEqual(before)
    const continuationInputs = after.filter(message => message.source === 'team-message'
      && message.metadata?.correlationId === `decision:${decision.id}`)
    expect(continuationInputs, 'The saved answer must enter the original member history exactly once').toHaveLength(1)
    expect(continuationInputs[0]).toMatchObject({ role: 'system', source: 'team-message',
      metadata: { correlationId: `decision:${decision.id}`, teamId: scope.teamId, epochId: scope.epochId, teamTriggerKind: 'message' } })
    expect(continuationInputs[0].content).toContain(question)
    expect(continuationInputs[0].content).toContain(answer)
    expect(after.some(message => message.role === 'assistant' && message.content.includes(completed))).toBe(true)
    await expect.poll(async () => (await readAcceptanceConversation(window, source.spaceId, source.conversationId)).messages
      .some(message => message.role === 'assistant' && message.content.includes(sourceDone)), { timeout: 30000 }).toBe(true)
    await waitForAcceptanceIdle(window, source.conversationId)
    const sourceHistory = await readAcceptanceConversation(window, source.spaceId, source.conversationId)
    expect(spawnCount).toBe(1)
    expect(askCount).toBe(1)
    expect(failures).toEqual([])

    const reopened = await acceptanceApp.restart()
    const collapse = reopened.getByRole('button', { name: 'Collapse canvas', exact: true })
    if (await collapse.isVisible()) await collapse.click()
    await openManagedConversation(reopened, sourceHistory.title, source.spaceId)
    const restoredRoom = await openMemberRoom(reopened, scope, member)
    await expect(restoredRoom.locator(`[id="decision-${decision.id}"]`)).toContainText(answer)
    expect(await history(reopened, scope, member.handle, source.spaceId)).toEqual(after)
    expect(await readDecision(reopened, member.handle, decision.id)).toMatchObject({ id: decision.id, appId: member.handle, sessionKey,
      userResponse: { text: answer }, continuation: { status: 'completed', attempts: 1 } })
    expect((await board(reopened, scope)).members.filter(value => !value.isSystemCoordinator).map(value => value.appId)).toEqual([member.handle])
    expect(await appIds(reopened)).toEqual(installedBefore)
    expect((await reopened.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGet(id), member.handle)).data ?? null).toBeNull()
    expect(resumed).toHaveLength(1)
    await info.attach('temporary-decision-identity', { contentType: 'application/json', body: JSON.stringify({ source, scope,
      member, decision: stored, installedBefore, before, after, resumed, spawnCount, askCount, failures }, null, 2) })
  })
