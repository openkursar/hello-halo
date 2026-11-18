import type { HaloAPI } from '../../../src/preload'
import { expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { test, GUEST_ID, changeGuestPolicy, waitForGuestChannel, waitForImIdle, imTranscript } from '../fixtures/acceptance-guest'
import { assignmentCall } from '../fixtures/acceptance-subagent-models'
import { refusedSecurityResult, securityConversation } from '../fixtures/acceptance-subagent-security'
import { scopedDirectoryScript } from '../fixtures/acceptance-subagent-authority'
import { parseModelDirectory } from '../fixtures/acceptance-subagent-wire'

test('an IM guest cannot list the configured assignments visible to the owner', acceptance('models.subagent-profiles.directory', { condition: 'scope-change' }), async ({ window, model, guestApp, wecom }, info) => {
  test.setTimeout(180000)
  const script = scopedDirectoryScript()
  model.respond(script.reply)
  const names = ['Private scope first', 'Private scope second']
  for (const name of names) {
    const saved = await assignmentCall(window, 'createSubagentModel', {
      name, description: 'PRIVATE_DIRECTORY_SCOPE_CANARY', target: { kind: 'model', sourceId: 'acceptance-local', modelId: 'gpt-4o' },
    })
    expect(saved.success, saved.error).toBe(true)
  }
  const owner = await securityConversation(window, 'OWNER_DIRECTORY_SCOPE: List the configured assignments.')
  await expect.poll(() => script.ownerResults.length, { timeout: 60000 }).toBeGreaterThan(0)
  await waitForAcceptanceIdle(window, owner)
  expect(script.ownerResults).toHaveLength(1)
  const ownerProfiles = parseModelDirectory(script.ownerResults[0]).profiles
  expect(ownerProfiles.map(profile => profile.name).sort()).toEqual([...names].sort())
  const ownerReferences = ownerProfiles.flatMap(profile => profile.selectionRef ? [profile.selectionRef] : [])
  expect(ownerReferences).toHaveLength(names.length)
  await changeGuestPolicy(window, guestApp, wecom, { notifications: false })
  const granted = await window.evaluate(instanceId => (globalThis as unknown as { halo: HaloAPI }).halo.imChannelsUpdateInstance(instanceId, {
    guestPolicy: { allowedTools: [], allowCollaboration: true },
  }), guestApp.instanceId)
  expect(granted.success, granted.error).toBe(true)
  await waitForGuestChannel(window, guestApp, wecom)
  const sent = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Isolated guest', chatId: GUEST_ID, chatType: 'direct', text: 'GUEST_DIRECTORY_SCOPE: List the configured assignments.' })
  await wecom.waitForReply({ requestId: sent.requestId })
  await waitForImIdle(window, guestApp, GUEST_ID)
  expect(script.guestResults.length).toBeGreaterThan(0)
  for (const result of script.guestResults) {
    expect(refusedSecurityResult(result)).toBe(true)
    expect(result).not.toContain('selectionRef')
    expect(result).not.toContain('PRIVATE_DIRECTORY_SCOPE_CANARY')
    for (const name of names) expect(result).not.toContain(name)
  }
  expect(script.guestRequests.length).toBeGreaterThan(0)
  for (const request of script.guestRequests) {
    expect(request.tools.some(name => name.endsWith('list_model_profiles'))).toBe(false)
    expect(request.text).not.toContain('PRIVATE_DIRECTORY_SCOPE_CANARY')
    expect(request.text).not.toContain('restoreRef')
    expect(request.text).not.toContain('local-scripted-endpoint')
  }
  const transcript = JSON.stringify((await imTranscript(window, guestApp, GUEST_ID)).messages)
  expect(transcript).not.toMatch(/restoreRef|PRIVATE_DIRECTORY_SCOPE_CANARY|local-scripted-endpoint/)
  for (const reference of ownerReferences) {
    expect(transcript).not.toContain(reference)
    for (const request of script.guestRequests) expect(request.text).not.toContain(reference)
  }
  expect(model.errors).toEqual([])
  await info.attach('directory-scope-outcome', { body: JSON.stringify({ ownerAssignmentCount: ownerProfiles.length, guestRefusals: script.guestResults, guestRequestCount: script.guestRequests.length }), contentType: 'application/json' })
})
