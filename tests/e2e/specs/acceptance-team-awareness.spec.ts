/**
 * Asking a digital human about its team work from its own chat: it knows which
 * teams it serves, reads their current state through Halo's own API, and a
 * message it passes on lands in the conversation it names — never in a newer,
 * unrelated one. Only the model endpoint is scripted; the engine's shell, the
 * self-API, the team service and storage are the real ones.
 */

import { randomUUID } from 'node:crypto'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import { modelTool, type ModelReply, type ModelRequest } from '../fixtures/acceptance-model'
import { openManagedPersonSettings, seedManagedSpace } from '../fixtures/acceptance-management'
import { createAwareTeam, hasOperateHalo, installTeammate, memberTranscript, promptOf, selfApi, systemOf } from '../fixtures/acceptance-team-awareness'

test.setTimeout(180000)

test('in its own chat a digital human reads its team live, is refused an unnamed message, and relays into the conversation it names', acceptance('teams.awareness.own-chat-relay'), async ({ model, window }, info) => {
  const token = randomUUID().slice(0, 8)
  const askerMarker = `asker-${token}`
  const testerMarker = `tester-${token}`
  const space = await seedManagedSpace(window, `Team awareness ${token}`)
  const askerName = `Coordinator ${token}`
  const askerId = await installTeammate(window, space.id, askerName, `You coordinate releases (${askerMarker}).`)
  const testerId = await installTeammate(window, space.id, `Tester ${token}`, `You verify finished requirements (${testerMarker}).`)
  const aware = await createAwareTeam(window, {
    spaceId: space.id, name: `Release crew ${token}`, askerAppId: askerId, askerRole: 'Release coordinator',
    teammateAppId: testerId, teammateRole: 'Test engineer', intendedLabel: 'Requirement 555241', unrelatedLabel: 'Bug triage 9017',
  })
  const { team, intended, unrelated } = aware
  const question = `Tell the tester in the 555241 work that requirement 555241 is done. ${token}`
  const relay = `Coordinator relaying for the owner: requirement 555241 is done (${token}).`
  const testerReply = `Noted, I will verify 555241 now (${token}).`
  const finalAnswer = `I told the tester in Requirement 555241; it was delivered and the tester will verify it (${token}).`
  const base = `/api/teams/${team.id}`
  const askerRequests: ModelRequest[] = []
  const testerRequests: ModelRequest[] = []
  const unexpected: number[] = []

  model.respond((request): ModelReply => {
    const system = systemOf(request)
    if (system.includes(testerMarker)) {
      testerRequests.push(request)
      return { text: testerReply }
    }
    if (!system.includes(askerMarker)) {
      unexpected.push(request.sequence)
      return { text: 'No work was requested here.' }
    }
    askerRequests.push(request)
    const results = new Set(request.toolResults.map(result => result.id))
    if (results.has('relay-named')) return { text: finalAnswer }
    if (results.has('unnamed')) {
      return { tools: [modelTool(request, 'Bash', {
        command: selfApi('POST', `${base}/members/${testerId}/send`, { message: relay, epochId: intended.epochId }),
        description: 'Relay the result into the conversation it belongs to', timeout: 120000,
      }, 'relay-named')] }
    }
    if (results.has('list')) {
      return { tools: [modelTool(request, 'Bash', {
        command: [
          selfApi('GET', `${base}/chat-messages?appId=${testerId}`),
          selfApi('POST', `${base}/members/${testerId}/send`, { message: relay }),
          selfApi('POST', `${base}/members/${testerId}/stop`, {}),
        ].join('; echo; '),
        description: 'Try the member calls without naming a conversation',
      }, 'unnamed')] }
    }
    return { tools: [modelTool(request, 'Bash', { command: selfApi('GET', `${base}/conversations`), description: 'List the team conversations' }, 'list')] }
  })

  const sent = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatSend(input), { appId: askerId, spaceId: space.id, message: question })
  expect(sent.success).toBe(true)
  const conversationId = (sent.data as { conversationId: string }).conversationId
  await expect.poll(async () => {
    const transcript = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: askerId, spaceId: space.id, conversationId })
    return transcript.success && transcript.data!.messages.some(message => message.role === 'assistant' && message.content.includes(finalAnswer))
  }, { timeout: 120000, message: 'The asker finishes its turn with the delivery report' }).toBe(true)

  const first = askerRequests[0]
  expect(first, 'The asker turn reached the model').toBeTruthy()
  expect(hasOperateHalo(first)).toBe(true)
  expect(first.tools).toContain('Bash')
  const firstPrompt = promptOf(first)
  expect(firstPrompt).toContain('## Teams')
  expect(firstPrompt).toContain(`Release crew ${token} (teamId ${team.id}) — role: Release coordinator (lead)`)
  expect(firstPrompt).toContain('Otherwise continue in this conversation.')
  expect(firstPrompt.match(/^# Halo$/gm)).toHaveLength(1)
  expect(firstPrompt).toContain('You run in Halo.')
  expect(firstPrompt).toContain('read_halo_doc')
  expect(firstPrompt).not.toContain('Settings > Remote Access')
  expect(firstPrompt).toContain(askerMarker)
  expect(firstPrompt.indexOf('# Halo\n')).toBeLessThan(firstPrompt.indexOf('## App Instructions'))
  expect(firstPrompt).toContain(`$HALO_API_URL/api/teams/<teamId>/conversations`)

  const result = (id: string) => askerRequests.flatMap(request => request.toolResults).find(item => item.id === id)
  const listed = result('list')
  expect(listed?.error).toBe(false)
  for (const conversation of [intended, unrelated]) {
    expect(listed!.text).toContain(conversation.epochId)
    expect(listed!.text).toContain(conversation.label)
  }
  const refused = result('unnamed')
  expect(refused?.error).toBe(false)
  expect(refused!.text.match(/halo\.team\.conversation_required/g)).toHaveLength(3)
  expect(refused!.text).toContain(intended.label)
  expect(refused!.text).toContain(unrelated.label)
  const relayed = result('relay-named')
  expect(relayed?.error).toBe(false)
  expect(relayed!.text).toContain('"ok":true')
  expect(relayed!.text).toContain(testerReply)

  expect(testerRequests).toHaveLength(1)
  expect(testerRequests[0].lastUserText).toContain(relay)
  const testerPrompt = promptOf(testerRequests[0])
  expect(testerPrompt).toContain(`This conversation is one of the conversations of the standing team "Release crew ${token}" (epochId ${intended.epochId}).`)
  expect(testerPrompt.match(/^# Halo$/gm)).toHaveLength(1)
  expect(testerPrompt).toContain('You run in Halo.')
  expect(testerPrompt).toContain(testerMarker)
  expect(testerPrompt).not.toContain(askerMarker)
  expect(testerPrompt).toContain('read_halo_doc')
  expect(testerPrompt).not.toContain('Settings > Remote Access')

  const inIntended = await memberTranscript(window, { appId: testerId, spaceId: space.id, teamId: team.id, epochId: intended.epochId })
  expect(inIntended.filter(message => message.role === 'user' && message.content.includes(relay))).toHaveLength(1)
  expect(inIntended.some(message => message.role === 'assistant' && message.content.includes(testerReply))).toBe(true)
  expect(await memberTranscript(window, { appId: testerId, spaceId: space.id, teamId: team.id, epochId: unrelated.epochId })).toEqual([])
  expect(unexpected, 'Every model request belongs to the asker or the tester').toEqual([])
  await info.attach('team-awareness-observations', {
    body: JSON.stringify({ team: team.id, intended, unrelated, refused: refused!.text, relayed: relayed!.text }, null, 2), contentType: 'application/json',
  })
})

test('a digital human lists Operate Halo as always on, with no switch to turn it off', acceptance('teams.awareness.always-on'), async ({ model, window }) => {
  const requests: number[] = []
  model.respond(request => { requests.push(request.sequence); return { text: 'No model work was requested.' } })
  const token = randomUUID().slice(0, 8)
  const space = await seedManagedSpace(window, `Always on ${token}`)
  const name = `Settings check ${token}`
  await installTeammate(window, space.id, name, 'Answer only what is asked.')
  await openManagedPersonSettings(window, name)
  await expect(window.getByText('Operate Halo', { exact: true })).toHaveCount(0)
  // Operate Halo sits in the Other group, collapsed while web search is on.
  const other = window.getByRole('button', { name: 'Other: web search, memory, operate Halo', exact: true })
  await expect(other).toHaveAttribute('aria-expanded', 'false')
  await other.click()
  await expect(other).toHaveAttribute('aria-expanded', 'true')
  const label = window.getByText('Operate Halo', { exact: true })
  await expect(label).toHaveCount(1)
  const row = label.locator('xpath=..')
  await expect(row).toContainText('Built-in · always on')
  await expect(row.getByRole('switch')).toHaveCount(0)
  expect(requests).toEqual([])
})
