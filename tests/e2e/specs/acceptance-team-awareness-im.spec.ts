/**
 * Asking a digital human about its team work through an IM chat bound to it:
 * the owner gets the same view of its teams as in its own chat, read live; a
 * guest in the same channel gets neither the team list nor a way to operate
 * Halo. The WeCom service and model endpoint are local fixtures; channel
 * dispatch, sender standing, the engine's shell and the self-API are real.
 */

import { randomUUID } from 'node:crypto'
import { test, expect, guestAcceptance, OWNER_ID, GUEST_ID, imTranscript, waitForImIdle } from '../fixtures/acceptance-guest'
import { modelTool, type ModelReply, type ModelRequest } from '../fixtures/acceptance-model'
import { createAwareTeam, hasOperateHalo, installTeammate, promptOf, selfApi, type AwareTeam } from '../fixtures/acceptance-team-awareness'
import type { GuestApp } from '../fixtures/acceptance-guest'
import type { Page } from '@playwright/test'

test.setTimeout(180000)

async function teamOf(page: Page, guestApp: GuestApp, token: string): Promise<AwareTeam> {
  const testerId = await installTeammate(page, guestApp.spaceId, `Tester ${token}`, 'You verify finished requirements.')
  return createAwareTeam(page, {
    spaceId: guestApp.spaceId, name: `Release crew ${token}`, askerAppId: guestApp.appId, askerRole: 'Release coordinator',
    teammateAppId: testerId, teammateRole: 'Test engineer', intendedLabel: 'Requirement 555241', unrelatedLabel: 'Bug triage 9017',
  })
}

test('the owner asking through IM gets its teams and reads a conversation live', guestAcceptance('teams.awareness.im-owner-reads'), async ({ guestApp, wecom, model, window }) => {
  const token = randomUUID().slice(0, 8)
  const { team, intended, unrelated } = await teamOf(window, guestApp, token)
  const question = `Which conversations is the release crew working in? ${token}`
  const answer = `The release crew is working in Requirement 555241 and Bug triage 9017 (${token}).`
  const owners: ModelRequest[] = []
  const unexpected: number[] = []
  model.respond((request): ModelReply => {
    // A tool result is the latest user message of a follow-up request, so the turn is recognized by its whole text.
    if (!request.text.includes(question)) { unexpected.push(request.sequence); return { text: 'No work was requested here.' } }
    owners.push(request)
    if (request.toolResults.some(result => result.id === 'im-list')) return { text: answer }
    return { tools: [modelTool(request, 'Bash', { command: selfApi('GET', `/api/teams/${team.id}/conversations`), description: 'List the team conversations' }, 'im-list')] }
  })
  const sent = await wecom.sendText({ senderId: OWNER_ID, senderName: 'Acceptance owner', chatId: OWNER_ID, chatType: 'direct', text: question })
  await wecom.waitForReply({ requestId: sent.requestId, contains: answer })
  await waitForImIdle(window, guestApp, OWNER_ID)

  expect(owners.length).toBeGreaterThanOrEqual(2)
  expect(hasOperateHalo(owners[0])).toBe(true)
  const prompt = promptOf(owners[0])
  expect(prompt).toContain('Your standing teams')
  expect(prompt).toContain(`Release crew ${token} (teamId ${team.id}) — your role: Release coordinator (lead)`)
  expect(prompt).toContain('This chat is your own, outside all of them.')
  const listed = owners.flatMap(request => request.toolResults).find(result => result.id === 'im-list')
  expect(listed?.error).toBe(false)
  for (const conversation of [intended, unrelated]) {
    expect(listed!.text).toContain(conversation.epochId)
    expect(listed!.text).toContain(conversation.label)
  }
  const history = await imTranscript(window, guestApp, OWNER_ID)
  expect(history.messages.filter(message => message.role === 'assistant' && message.content.includes(answer))).toHaveLength(1)
  expect(unexpected).toEqual([])
})

test('a guest asking through IM is given neither the team list nor Operate Halo', guestAcceptance('teams.awareness.im-guest-withheld'), async ({ guestApp, wecom, model, window }) => {
  const token = randomUUID().slice(0, 8)
  const { team } = await teamOf(window, guestApp, token)
  const question = `What is the release crew working on? ${token}`
  const refusal = `I can only answer general questions here (${token}).`
  const guests: ModelRequest[] = []
  const unexpected: number[] = []
  model.respond((request): ModelReply => {
    if (!request.lastUserText.includes(question)) { unexpected.push(request.sequence); return { text: 'No work was requested here.' } }
    guests.push(request)
    return { text: refusal }
  })
  const sent = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Acceptance guest', chatId: GUEST_ID, chatType: 'direct', text: question })
  await wecom.waitForReply({ requestId: sent.requestId, contains: refusal })
  await waitForImIdle(window, guestApp, GUEST_ID)

  expect(guests).toHaveLength(1)
  expect(hasOperateHalo(guests[0])).toBe(false)
  const prompt = promptOf(guests[0])
  expect(prompt).toContain('This sender is a guest')
  expect(prompt).not.toContain('Your standing teams')
  expect(prompt).not.toContain(team.id)
  expect(prompt).not.toContain('$HALO_API_URL')
  expect(unexpected).toEqual([])
})
