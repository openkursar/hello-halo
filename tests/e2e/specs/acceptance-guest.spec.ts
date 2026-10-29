import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { ImSessionRecord } from '../../../src/shared/types/im-channel'
import {
  test, expect, guestAcceptance, OWNER_ID, GUEST_ID, GROUP_ID, OWNER_QUESTION, OWNER_REPLY,
  changeGuestPolicy, guestConfiguration, imTranscript, showImConversation, waitForGuestChannel,
  waitForImIdle, type GuestApp,
} from '../fixtures/acceptance-guest'
import type { AcceptanceWecom } from '../fixtures/acceptance-wecom'
import { createModelGate, modelTool, type ModelRequest, type ModelReply } from '../fixtures/acceptance-model'

test.setTimeout(120000)

function ownerReply(request: ModelRequest, observations: ModelRequest[]): ModelReply | undefined {
  if (!request.lastUserText.includes(OWNER_QUESTION)) return
  observations.push(request)
  return { text: OWNER_REPLY }
}

async function registerOwner(page: Page, context: GuestApp, wecom: AcceptanceWecom, observations: ModelRequest[]) {
  const request = await wecom.sendText({ senderId: OWNER_ID, senderName: 'Acceptance owner', chatId: OWNER_ID, chatType: 'direct', text: OWNER_QUESTION })
  await wecom.waitForReply({ requestId: request.requestId, contains: OWNER_REPLY })
  await waitForImIdle(page, context, OWNER_ID)
  expect(observations).toHaveLength(1)
  expect(observations[0].tools.some(name => name.endsWith('__notify_bot'))).toBe(true)
  expect(observations[0].tools.some(name => name.includes('report_to_user'))).toBe(false)
}

function contradictoryGrantClaims(request: ModelRequest): string[] {
  return [
    'This sender is a guest — read-only query only.',
    'Guest users (non-owners) cannot trigger notify_bot.',
    'Only owners can perform sensitive operations (file changes, notifications,',
    'Other users (guests) have NO permission',
    '1. The owner explicitly asks to send/forward to a specific contact',
  ].filter(claim => request.text.includes(claim))
}

function isRefusal(text: string): boolean {
  return /(?:\b(?:permissions?|access) denied\b|\bpermission to (?:use|call) [^\n]{1,120}(?:was|is|has been) denied\b|\bnot (?:allowed|permitted|granted|authorized)\b|Only files inside this workspace can be used here|\bunknown (?:tool|function)\b|\b(?:tool|function)[^\n]{0,180}(?:not found|not registered|unavailable))/i.test(text)
}

async function expectStoredReply(page: Page, context: GuestApp, chatId: string, request: string, reply: string, chatType: 'direct' | 'group' = 'direct') {
  await waitForImIdle(page, context, chatId, chatType)
  const history = await imTranscript(page, context, chatId, chatType)
  expect(history.messages.filter(message => message.role === 'user' && message.content.includes(request))).toHaveLength(1)
  expect(history.messages.filter(message => message.role === 'assistant' && message.content.includes(reply))).toHaveLength(1)
  expect(history.messages.some(message => /FOREIGN KEY|SQLITE_|constraint failed/i.test(message.content))).toBe(false)
  await showImConversation(page, context, chatId, reply)
  return history
}

async function expectRegisteredRecipient(page: Page, context: GuestApp) {
  const result = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.imSessionsList(appId), context.appId)
  expect(result.success).toBe(true)
  expect((result.data as ImSessionRecord[]).filter(session => session.instanceId === context.instanceId && session.channel === 'wecom-bot' && session.chatId === OWNER_ID)).toHaveLength(1)
}

test('a guest cannot use withheld notifications and a subsequent normal question still completes', guestAcceptance('permissions.enforcement.tool-denied'), async ({ guestApp, wecom, model, window }) => {
  const owners: ModelRequest[] = []
  const guestRequests: ModelRequest[] = []
  const marker = `withheld-${randomUUID()}`
  const question = `Notify the owner with ${marker}.`
  const refusal = 'Notifications are not enabled for this guest. Normal questions are still available.'
  const followup = 'Answer this ordinary follow-up question without sending a notification.'
  const answer = 'The ordinary follow-up completed.'
  model.respond(request => {
    const owner = ownerReply(request, owners)
    if (owner) return owner
    guestRequests.push(request)
    if (request.lastUserText.includes(question)) return { text: refusal }
    if (request.lastUserText.includes(followup)) return { text: answer }
    throw new Error(`Unexpected guest request ${request.sequence}`)
  })
  await registerOwner(window, guestApp, wecom, owners)
  const before = wecom.replies.length
  const denied = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Acceptance guest', chatId: GUEST_ID, chatType: 'direct', text: question })
  await wecom.waitForReply({ requestId: denied.requestId, contains: refusal })
  await expectStoredReply(window, guestApp, GUEST_ID, question, refusal)
  const next = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Acceptance guest', chatId: GUEST_ID, chatType: 'direct', text: followup })
  await wecom.waitForReply({ requestId: next.requestId, contains: answer })
  await expectStoredReply(window, guestApp, GUEST_ID, followup, answer)
  expect(guestRequests).toHaveLength(2)
  for (const request of guestRequests) {
    expect(request.tools.some(name => name.endsWith('__notify_bot') || name.includes('report_to_user'))).toBe(false)
    expect(request.text).not.toContain('`notify_bot` — Send a message or file to another IM contact.')
    expect(request.text).toContain(GUEST_ID)
    expect(request.text).toContain('This sender is a guest')
  }
  expect(wecom.replies.slice(before).filter(reply => reply.chatId === OWNER_ID && reply.text.includes(marker))).toEqual([])
  expect(wecom.replies.filter(reply => reply.requestId === denied.requestId && reply.finished && reply.text.includes(refusal))).toHaveLength(1)
  expect((await guestConfiguration(window, guestApp.instanceId)).owners).toEqual([OWNER_ID])
})

test('explicitly granted guest notifications execute once through the bound bot and are described consistently', guestAcceptance('permissions.enforcement.notify-granted'), async ({ guestApp, wecom, model, window }) => {
  const owners: ModelRequest[] = []
  const grants: ModelRequest[] = []
  const marker = `granted-${randomUUID()}`
  const question = `Use the granted notification capability to send ${marker} to the owner.`
  const answer = 'The permitted notification was delivered.'
  let toolResult: ModelRequest['toolResults'][number] | undefined
  model.respond(request => {
    const owner = ownerReply(request, owners)
    if (owner) return owner
    const result = request.toolResults.find(result => result.id === 'granted-notification')
    if (result) { toolResult = result; return { text: answer } }
    if (request.lastUserText.includes(question)) {
      grants.push(request)
      return { tools: [modelTool(request, 'notify_bot', { to: `${guestApp.instanceId}:${OWNER_ID}`, message: marker }, 'granted-notification')] }
    }
    throw new Error(`Unexpected granted-notification request ${request.sequence}`)
  })
  await registerOwner(window, guestApp, wecom, owners)
  await changeGuestPolicy(window, guestApp, wecom, { notifications: true })
  const before = wecom.replies.length
  const request = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Acceptance guest', chatId: GUEST_ID, chatType: 'direct', text: question })
  const notification = await wecom.waitForReply({ chatId: OWNER_ID, after: before, contains: marker })
  expect(notification.command).toBe('aibot_send_msg')
  await wecom.waitForReply({ requestId: request.requestId, contains: answer })
  await expectStoredReply(window, guestApp, GUEST_ID, question, answer)
  expect(toolResult?.error).toBe(false)
  expect(toolResult?.text).not.toMatch(/FOREIGN KEY|SQLITE_|constraint failed|not sent|failed to send/i)
  expect(wecom.replies.slice(before).filter(reply => reply.chatId === OWNER_ID && reply.text.includes(marker))).toHaveLength(1)
  expect(grants).toHaveLength(1)
  expect(contradictoryGrantClaims(grants[0]), 'A granted capability must not still be described to the model as forbidden').toEqual([])
})

test('revoking guest notifications blocks a previously valid tool call and remains effective after restart', guestAcceptance('permissions.enforcement.revoke'), async ({ acceptanceApp, guestApp, wecom, model, window }, testInfo) => {
  const owners: ModelRequest[] = []
  const grants: ModelRequest[] = []
  const refused: ModelRequest['toolResults'] = []
  const allowedMarker = `before-revocation-${randomUUID()}`
  const blockedMarker = `after-revocation-${randomUUID()}`
  const permittedQuestion = 'Send the permitted notification before I change access.'
  const revokedQuestion = 'Try the same notification operation after access has been revoked.'
  const allowedAnswer = 'The notification before revocation completed.'
  const deniedAnswer = 'The previous notification tool is no longer permitted.'
  const followup = 'Answer a normal question after the blocked notification.'
  const ordinaryAnswer = 'Normal guest chat still works after revocation.'
  let previousTool: string | undefined
  let attempted = false
  let restartAttempted = false
  let afterRestart = false
  const deniedRequests: ModelRequest[] = []
  model.respond(request => {
    const owner = ownerReply(request, owners)
    if (owner) return owner
    if (request.lastUserText.includes(followup)) return { text: ordinaryAnswer }
    if (afterRestart) {
      const result = request.toolResults.find(result => result.id === 'restarted-revoked-notification')
      if (result) { refused.push(result); return { text: deniedAnswer } }
      deniedRequests.push(request)
      if (!previousTool || restartAttempted) throw new Error('The restarted session must attempt the previous tool exactly once')
      restartAttempted = true
      return { tools: [{ id: 'restarted-revoked-notification', name: previousTool, input: { to: `${guestApp.instanceId}:${OWNER_ID}`, message: blockedMarker } }] }
    }
    const refusal = request.toolResults.find(result => result.id === 'revoked-notification')
    if (refusal) { refused.push(refusal); return { text: deniedAnswer } }
    if (request.lastUserText.includes(revokedQuestion)) {
      deniedRequests.push(request)
      if (!previousTool || attempted) throw new Error('The revocation fixture must attempt the previously accepted tool exactly once')
      attempted = true
      return { tools: [{ id: 'revoked-notification', name: previousTool, input: { to: `${guestApp.instanceId}:${OWNER_ID}`, message: blockedMarker } }] }
    }
    const result = request.toolResults.find(result => result.id === 'before-revocation')
    if (result) return { text: allowedAnswer }
    if (request.lastUserText.includes(permittedQuestion)) {
      grants.push(request)
      const tool = modelTool(request, 'notify_bot', { to: `${guestApp.instanceId}:${OWNER_ID}`, message: allowedMarker }, 'before-revocation')
      previousTool = tool.name
      return { tools: [tool] }
    }
    throw new Error(`Unexpected revocation request ${request.sequence}`)
  })
  await registerOwner(window, guestApp, wecom, owners)
  await changeGuestPolicy(window, guestApp, wecom, { notifications: true })
  const allowed = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Acceptance guest', chatId: GUEST_ID, chatType: 'direct', text: permittedQuestion })
  const notification = await wecom.waitForReply({ chatId: OWNER_ID, contains: allowedMarker })
  expect(notification.command).toBe('aibot_send_msg')
  await wecom.waitForReply({ requestId: allowed.requestId, contains: allowedAnswer })
  await waitForImIdle(window, guestApp, GUEST_ID)
  await changeGuestPolicy(window, guestApp, wecom, { notifications: false })
  await expectRegisteredRecipient(window, guestApp)
  const before = wecom.replies.length
  const blocked = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Acceptance guest', chatId: GUEST_ID, chatType: 'direct', text: revokedQuestion })
  const reply = await wecom.waitForReply({ requestId: blocked.requestId, after: before })
  await waitForImIdle(window, guestApp, GUEST_ID)
  expect(attempted).toBe(true)
  expect(deniedRequests).toHaveLength(1)
  expect(deniedRequests[0].tools).not.toContain(previousTool)
  expect(deniedRequests[0].tools.some(name => name.endsWith('__notify_bot'))).toBe(false)
  expect(refused.length > 0 ? isRefusal(refused[0].text) : isRefusal(reply.text)).toBe(true)
  expect(reply.text).not.toMatch(/FOREIGN KEY|SQLITE_|constraint failed/i)
  expect(wecom.replies.slice(before).filter(reply => reply.chatId === OWNER_ID && reply.text.includes(blockedMarker))).toEqual([])
  await testInfo.attach('guest-revocation-boundary', { body: JSON.stringify({ attemptedTool: previousTool, toolAdvertised: false, refusalAt: refused.length ? 'tool-result' : 'sdk-turn', reply: reply.text }), contentType: 'application/json' })
  const normal = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Acceptance guest', chatId: GUEST_ID, chatType: 'direct', text: followup })
  await wecom.waitForReply({ requestId: normal.requestId, contains: ordinaryAnswer })
  await expectStoredReply(window, guestApp, GUEST_ID, followup, ordinaryAnswer)
  afterRestart = true
  const reopened = await acceptanceApp.restart()
  await waitForGuestChannel(reopened, guestApp, wecom)
  await expectRegisteredRecipient(reopened, guestApp)
  expect((await guestConfiguration(reopened, guestApp.instanceId)).guestPolicy?.allowNotify).toBe(false)
  const restartIndex = wecom.replies.length
  const resumed = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Acceptance guest', chatId: GUEST_ID, chatType: 'direct', text: 'The revoked notification must remain unavailable after restart.' })
  const restartedReply = await wecom.waitForReply({ requestId: resumed.requestId, after: restartIndex })
  await waitForImIdle(reopened, guestApp, GUEST_ID)
  expect(restartAttempted).toBe(true)
  expect(deniedRequests).toHaveLength(2)
  expect(deniedRequests[1].tools.some(name => name.endsWith('__notify_bot'))).toBe(false)
  const restartedRefusal = refused.find(result => result.id === 'restarted-revoked-notification')
  expect(isRefusal(restartedRefusal?.text ?? restartedReply.text)).toBe(true)
  expect(restartedReply.text).not.toMatch(/FOREIGN KEY|SQLITE_|constraint failed/i)
  expect(wecom.replies.slice(before).filter(reply => reply.chatId === OWNER_ID && reply.text.includes(blockedMarker))).toEqual([])
  const afterRestartQuestion = `${followup} The application has restarted.`
  const continued = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Acceptance guest', chatId: GUEST_ID, chatType: 'direct', text: afterRestartQuestion })
  await wecom.waitForReply({ requestId: continued.requestId, contains: ordinaryAnswer })
  await waitForImIdle(reopened, guestApp, GUEST_ID)
  const restored = await imTranscript(reopened, guestApp, GUEST_ID)
  expect(restored.messages.filter(message => message.role === 'user' && message.content.includes(afterRestartQuestion))).toHaveLength(1)
  expect(restored.messages.filter(message => message.role === 'assistant' && message.content.includes(ordinaryAnswer))).toHaveLength(2)
  await showImConversation(reopened, guestApp, GUEST_ID, ordinaryAnswer)
  await testInfo.attach('restarted-guest-revocation-boundary', { body: JSON.stringify({ attemptedTool: previousTool, toolAdvertised: false, refusalAt: restartedRefusal ? 'tool-result' : 'sdk-turn', reply: restartedReply.text }), contentType: 'application/json' })
  expect(contradictoryGrantClaims(grants[0]), 'The allowed part of the scenario must not contradict the owner’s explicit grant').toEqual([])
})

test('a guest arriving during owner work in the same group cannot inherit the owner execution authority', guestAcceptance('permissions.enforcement.live-isolation'), async ({ guestApp, wecom, model, window }) => {
  const owners: ModelRequest[] = []
  const gate = createModelGate()
  const ownerFile = join(guestApp.workDir, 'owner-authorized.txt')
  const guestFile = join(guestApp.workDir, 'guest-must-not-write.txt')
  const ownerQuestion = `Owner work ${randomUUID()}: create the authorized file and wait.`
  const guestQuestion = `Guest request ${randomUUID()}: create a file with the same authority.`
  const ownerAnswer = 'The owner work completed.'
  const guestAnswer = 'The guest file operation was refused under its own permissions.'
  const ownerRequests: ModelRequest[] = []
  const guestRequests: ModelRequest[] = []
  let guestResult: ModelRequest['toolResults'][number] | undefined
  model.respond(request => {
    const owner = ownerReply(request, owners)
    if (owner) return owner
    const rejected = request.toolResults.find(result => result.id === 'guest-write')
    if (rejected) { guestResult = rejected; return { text: guestAnswer } }
    if (request.lastUserText.includes(guestQuestion)) {
      guestRequests.push(request)
      return { tools: [modelTool(request, 'Write', { file_path: guestFile, content: 'Guest side effect must not occur.' }, 'guest-write')] }
    }
    ownerRequests.push(request)
    if (request.toolResults.some(result => result.id === 'owner-write')) return { text: ownerAnswer, hold: gate.promise }
    if (request.lastUserText.includes(ownerQuestion)) return { tools: [modelTool(request, 'Write', { file_path: ownerFile, content: 'Owner-authorized output.' }, 'owner-write')] }
    throw new Error(`Unexpected group-isolation request ${request.sequence}`)
  })
  await registerOwner(window, guestApp, wecom, owners)
  expect(existsSync(ownerFile)).toBe(false)
  expect(existsSync(guestFile)).toBe(false)
  const owner = await wecom.sendText({ senderId: OWNER_ID, senderName: 'Acceptance owner', chatId: GROUP_ID, chatType: 'group', text: ownerQuestion })
  try {
    await expect.poll(() => existsSync(ownerFile)).toBe(true)
    await expect.poll(() => ownerRequests.length).toBe(2)
    const before = wecom.replies.length
    const guest = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Acceptance guest', chatId: GROUP_ID, chatType: 'group', text: guestQuestion })
    await wecom.waitForReply({ chatId: GROUP_ID, after: before })
    expect(ownerRequests.some(request => request.text.includes(guestQuestion))).toBe(false)
    expect(guestRequests).toHaveLength(0)
    gate.release()
    await wecom.waitForReply({ requestId: owner.requestId, contains: ownerAnswer })
    await wecom.waitForReply({ requestId: guest.requestId, contains: guestAnswer })
    await expectStoredReply(window, guestApp, GROUP_ID, guestQuestion, guestAnswer, 'group')
    expect(guestRequests).toHaveLength(1)
    expect(guestRequests[0].tools.some(name => name.endsWith('__notify_bot'))).toBe(false)
    expect(isRefusal(guestResult?.text ?? '')).toBe(true)
    expect(existsSync(guestFile)).toBe(false)
    expect(readFileSync(ownerFile, 'utf8')).toBe('Owner-authorized output.')
  } finally { gate.release() }
})

test('guest file reads stay within the workspace despite parent traversal and an external symbolic link', guestAcceptance('permissions.files.containment'), async ({ guestApp, wecom, model, window }) => {
  const owners: ModelRequest[] = []
  const allowed = join(guestApp.workDir, 'allowed-evidence.txt')
  const outsideDirectory = join(guestApp.profile, 'outside-guest-workspace')
  mkdirSync(outsideDirectory, { recursive: true })
  const outside = join(outsideDirectory, 'private-control.txt')
  const alias = join(guestApp.workDir, 'external-evidence.txt')
  const allowedMarker = `Allowed evidence ${randomUUID()}`
  const outsideMarker = `Outside evidence ${randomUUID()}`
  writeFileSync(allowed, allowedMarker)
  writeFileSync(outside, outsideMarker)
  symlinkSync(outside, alias, 'file')
  const question = 'Check the allowed file and test the declared workspace read boundary.'
  const answer = 'The workspace file was read; outside files were refused.'
  const results: ModelRequest['toolResults'] = []
  const traversal = `${guestApp.workDir}${sep}${relative(guestApp.workDir, outside)}`
  expect(resolve(traversal)).toBe(resolve(outside))
  const targets = [allowed, traversal, outside, alias]
  model.respond(request => {
    const owner = ownerReply(request, owners)
    if (owner) return owner
    for (let index = 0; index < targets.length; index++) {
      const id = `guest-read-${index}`
      const result = request.toolResults.find(result => result.id === id)
      if (!result) return { tools: [modelTool(request, 'Read', { file_path: targets[index] }, id)] }
      if (!results.some(item => item.id === id)) results.push(result)
    }
    return { text: answer }
  })
  await registerOwner(window, guestApp, wecom, owners)
  await changeGuestPolicy(window, guestApp, wecom, { readFiles: true, notifications: false })
  const request = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Acceptance guest', chatId: GUEST_ID, chatType: 'direct', text: question })
  await wecom.waitForReply({ requestId: request.requestId, contains: answer })
  await expectStoredReply(window, guestApp, GUEST_ID, question, answer)
  expect(results).toHaveLength(targets.length)
  expect(results[0].error).toBe(false)
  expect(results[0].text).toContain(allowedMarker)
  for (const result of results.slice(1)) {
    expect(result.text).not.toContain(outsideMarker)
    expect(isRefusal(result.text)).toBe(true)
    expect(result.text).not.toMatch(/FOREIGN KEY|SQLITE_|constraint failed/i)
  }
  expect(readFileSync(allowed, 'utf8')).toBe(allowedMarker)
  expect(readFileSync(outside, 'utf8')).toBe(outsideMarker)
  expect(wecom.replies.some(reply => reply.text.includes(outsideMarker))).toBe(false)
})
