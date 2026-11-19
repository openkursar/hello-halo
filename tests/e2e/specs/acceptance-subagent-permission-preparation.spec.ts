import { fileURLToPath } from 'node:url'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, OWNER_ID, GROUP_ID, waitForImIdle } from '../fixtures/acceptance-guest'
import { acceptance } from '../fixtures/acceptance-app'
import { assignmentCall } from '../fixtures/acceptance-subagent-models'
import { assignmentTool, parseModelDirectory } from '../fixtures/acceptance-subagent-wire'
import { initialUserInput } from '../fixtures/acceptance-model'
import { subagentEffects } from '../fixtures/acceptance-subagent-effects'

type CredentialGate = { cancellationCredentialGate: { state(): { sessionRequests: number; sessionResponses: number; inferenceRequests: number; unexpected: string[] }; release(): void } }

test.use({ sdkEngine: 'halo', startupObserver: fileURLToPath(new URL('../fixtures/subagent-credential-gate.cjs', import.meta.url)) })
test('revoking an owner IM source permission during credential preparation prevents child creation', acceptance('models.subagent-profiles.policy-race', { change: 'permission-revocation' }), async ({ window, model, acceptanceApp, guestApp, wecom }, info) => {
  test.setTimeout(180000)
  const marker = 'IM_PERMISSION_PREPARATION: Delegate verification to Verifier.'
  const control = 'IM_PERMISSION_CONTROL: Answer without delegation.'
  let refusal: string | undefined
  let spawns = 0
  const errors: string[] = []
  model.respond(request => {
    if (initialUserInput(request).includes(control)) return { text: 'Independent IM conversation completed.' }
    if (!initialUserInput(request).includes(marker)) { errors.push('Unexpected IM preparation actor'); return { text: 'Unexpected actor.' } }
    const spawned = request.toolResults.find(result => result.id === 'authority-spawn')
    if (spawned) {
      if (!/request.*stopped|source.*revoked|authority.*(?:changed|revoked)/i.test(spawned.text)) errors.push('Revoked IM request did not return its authority refusal')
      refusal = spawned.text
      return { text: 'The revoked request did not create a collaborator.' }
    }
    const catalog = request.toolResults.find(result => result.id === 'authority-directory')
    if (!catalog) return assignmentTool(request, 'list_model_profiles', {}, 'authority-directory')
    const reference = parseModelDirectory(catalog.text).profiles?.find((profile: { name: string }) => profile.name === 'Verifier')?.selectionRef
    if (!reference) { errors.push('Owner IM directory did not expose Verifier'); return { text: 'Verifier unavailable.' } }
    const reply = assignmentTool(request, 'spawn_agent', { name: 'Revoked verifier', prompt: 'IM_PERMISSION_CHILD: Verify this task.', model_profile: reference }, 'authority-spawn')
    if (reply.tools?.some(tool => tool.id === 'authority-spawn')) spawns++
    return reply
  })
  const configured = await assignmentCall(window, 'createSubagentModel', { name: 'Verifier', description: 'Verify source permission boundaries', target: { kind: 'model', sourceId: 'cancellation-copilot', modelId: 'gpt-4o' } })
  expect(configured.success, configured.error).toBe(true)
  const permission = 'filesystem:read'
  const granted = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appGrantPermission(input), { appId: guestApp.appId, permission })
  expect(granted.success, granted.error).toBe(true)
  const before = subagentEffects(acceptanceApp.profile)
  try {
    await wecom.sendText({ senderId: OWNER_ID, senderName: 'Owner', chatId: GROUP_ID, chatType: 'group', text: marker })
    await expect.poll(() => spawns, { timeout: 30000 }).toBe(1)
    await expect.poll(() => acceptanceApp.app.evaluate(() => (globalThis as unknown as CredentialGate).cancellationCredentialGate.state().sessionRequests), { timeout: 15000 }).toBe(1)
    expect(subagentEffects(acceptanceApp.profile)).toEqual(before)
    const revoked = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appRevokePermission(input), { appId: guestApp.appId, permission })
    expect(revoked.success, revoked.error).toBe(true)
    await acceptanceApp.app.evaluate(() => (globalThis as unknown as CredentialGate).cancellationCredentialGate.release())
    await expect.poll(() => refusal, { timeout: 30000 }).toMatch(/request.*stopped|source.*revoked|authority.*(?:changed|revoked)/i)
    await waitForImIdle(window, guestApp, GROUP_ID, 'group')
    await wecom.sendText({ senderId: OWNER_ID, senderName: 'Owner', chatId: 'acceptance-independent-permission-control', chatType: 'direct', text: control })
    await wecom.waitForReply({ chatId: 'acceptance-independent-permission-control', contains: 'Independent IM conversation completed.', timeoutMs: 45000 })
    await waitForImIdle(window, guestApp, 'acceptance-independent-permission-control')
    expect(spawns).toBe(1)
    expect(errors).toEqual([])
    expect(subagentEffects(acceptanceApp.profile)).toEqual(before)
    const state = await acceptanceApp.app.evaluate(() => (globalThis as unknown as CredentialGate).cancellationCredentialGate.state())
    expect(state.sessionResponses).toBe(1)
    expect(state.inferenceRequests).toBe(0)
    expect(state.unexpected.filter(value => !value.startsWith('external:'))).toEqual([])
    await info.attach('owner-im-authority-revoked-during-preparation', { body: JSON.stringify({ appId: guestApp.appId, permission, refusal, spawns, before, after: subagentEffects(acceptanceApp.profile), state }, null, 2), contentType: 'application/json' })
  } finally {
    await acceptanceApp.app.evaluate(() => (globalThis as unknown as CredentialGate).cancellationCredentialGate.release())
  }
})
