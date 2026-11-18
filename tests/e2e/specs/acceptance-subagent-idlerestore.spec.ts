import { fileURLToPath } from 'node:url'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { startAcceptanceModel, initialUserInput, type ModelRequest } from '../fixtures/acceptance-model'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { assignmentCall, assignmentSettings } from '../fixtures/acceptance-subagent-models'
import { addSecuritySource, decodeSecurityResult, securityConversation, securityTool, securityCredentialRelay } from '../fixtures/acceptance-subagent-security'

type IdleClock = { advance(): number; reset(): void; observations(): Array<{ conversationId: string }>; sessions(): Array<{ sequence: number; model: string; closed: boolean }> }
test.use({ startupObserver: fileURLToPath(new URL('../fixtures/subagent-idle-clock-observer.cjs', import.meta.url)) })

for (const change of ['profile-edit', 'profile-delete-recreate', 'builtin-clear-rebind', 'credential-rotation', 'same-account-endpoint-edit', 'account-delete', 'group-delete', 'capability-shrink', 'group-capability-shrink', 'parent-change'] as const) {
  test(`idle retirement preserves existing member after ${change}`, acceptance('models.subagent-profiles.restore', { change, boundary: 'idle' }), async ({ window, model, acceptanceApp }, info) => {
    test.setTimeout(240000)
    const endpoint = await startAcceptanceModel()
    const replacement = await startAcceptanceModel()
    const relay = await securityCredentialRelay(endpoint.url)
    const requests: ModelRequest[] = []
    const parentRequests: ModelRequest[] = []
    let handle: string | undefined
    let resumed = false
    const targetModel = change === 'capability-shrink' ? 'claude-sonnet-4-5' : change === 'group-capability-shrink' ? 'gpt-6.1-sol' : 'o3'
    const effort = change === 'group-capability-shrink' ? 'max' : 'high'
    endpoint.respond(request => { requests.push(request); return { text: resumed ? 'IDLE_ORIGINAL_CONTINUED' : 'IDLE_ORIGINAL_HISTORY_CANARY' } })
    replacement.respond(() => ({ text: 'IDLE_EDITED_ENDPOINT_CONTINUED' }))
    model.respond(request => {
      parentRequests.push(request)
      if (resumed) {
        if (request.toolResults.some(result => result.id === 'idle-send')) return { text: 'IDLE_FOLLOWUP_DISPATCHED' }
        return securityTool(request, 'team_send', { to: handle, message: 'IDLE_CHILD_FOLLOWUP: Continue the original assignment.' }, 'idle-send')
      }
      const created = request.toolResults.find(result => result.id === 'idle-spawn')
      if (created) { handle = collaboratorReceipt(created).handle; return { text: 'IDLE_PARENT_READY' } }
      const catalog = request.toolResults.find(result => result.id === 'idle-directory')
      if (!catalog) return securityTool(request, 'list_model_profiles', {}, 'idle-directory')
      const reference = decodeSecurityResult(catalog.text).profiles?.find((profile: { name: string }) => profile.name === 'Idle verifier' || change === 'builtin-clear-rebind' && profile.name === 'Small (小杯)')?.selectionRef
      if (!reference) return { text: 'IDLE_PROFILE_MISSING' }
      return securityTool(request, 'spawn_agent', { name: 'Idle bound worker', prompt: 'IDLE_CHILD: Retain this original assignment.', model_profile: reference }, 'idle-spawn')
    })
    try {
      const sourceId = await addSecuritySource(window, relay.url, 'Idle original account', targetModel)
      const replacementId = await addSecuritySource(window, replacement.url, 'Idle replacement account', 'o3')
      const configured = await window.evaluate(({ sourceId, targetModel, effort, native }) => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesUpdateSource(sourceId, {
        ...(native ? { provider: 'anthropic', apiType: 'anthropic_passthrough' } : {}), availableModels: [...new Set([targetModel, 'o3'])].map(id => ({ id, name: id })),
        modelOverrides: { [targetModel]: { reasoningEffort: effort, thinking: true, maxOutputTokens: 32768 } },
      }), { sourceId, targetModel, effort, native: change === 'capability-shrink' })
      expect(configured.success, configured.error).toBe(true)
      let groupId: string | undefined
      if (change === 'group-delete' || change === 'group-capability-shrink') {
        const group = await window.evaluate(({ sourceId, targetModel }) => (globalThis as unknown as { halo: HaloAPI }).halo.aiGroupsCreate({ name: 'Idle binding pool', members: [{ sourceId, modelId: targetModel }] }), { sourceId, targetModel })
        expect(group.success, group.error).toBe(true)
        groupId = group.data!.groupId
      }
      const settings = await assignmentSettings(window)
      const builtin = settings.profiles.find(profile => profile.id === 'builtin:small')!
      const saved = await assignmentCall(window, change === 'builtin-clear-rebind' ? 'updateSubagentModel' : 'createSubagentModel', {
        ...(change === 'builtin-clear-rebind' ? { id: builtin.id, expectedRevision: builtin.revision } : { name: 'Idle verifier' }), description: 'Retain original idle binding',
        target: groupId ? { kind: 'group', groupId } : { kind: 'model', sourceId, modelId: targetModel }, reasoningEffort: effort,
      })
      expect(saved.success, saved.error).toBe(true)
      const profile = saved.data!.profiles.find(profile => change === 'builtin-clear-rebind' ? profile.id === builtin.id : profile.kind === 'custom' && profile.name === 'Idle verifier')!
      const conversationId = await securityConversation(window, 'IDLE_PARENT: Create the verifier once.')
      await expect.poll(() => Boolean(handle) && requests.length > 0, { timeout: 90000 }).toBe(true)
      await waitForAcceptanceIdle(window, conversationId)
      expect(requests.every(request => request.body.model === targetModel)).toBe(true)
      if (change === 'capability-shrink') expect(requests.every(request => request.body.thinking?.budget_tokens === 10240)).toBe(true)
      else expect(requests.every(request => request.body.reasoning_effort === effort)).toBe(true)
      const before = requests.length
      const nativeBefore = await acceptanceApp.app.evaluate(() => (globalThis as unknown as { subagentIdleClock: IdleClock }).subagentIdleClock.sessions())
      expect(nativeBefore.some(session => session.model === (groupId ? 'halo-auto' : targetModel) && !session.closed)).toBe(true)
      await acceptanceApp.app.evaluate(() => (globalThis as unknown as { subagentIdleClock: IdleClock }).subagentIdleClock.advance())
      try {
        await expect.poll(() => acceptanceApp.app.evaluate(() => (globalThis as unknown as { subagentIdleClock: IdleClock }).subagentIdleClock.observations()), { timeout: 75000 }).toEqual(expect.arrayContaining([expect.objectContaining({ conversationId: expect.stringContaining(handle!) })]))
        await expect.poll(() => acceptanceApp.app.evaluate(() => (globalThis as unknown as { subagentIdleClock: IdleClock }).subagentIdleClock.sessions()), { timeout: 10000 }).toEqual(expect.arrayContaining(nativeBefore.filter(session => !session.closed).map(session => ({ ...session, closed: true }))))
      } finally { await acceptanceApp.app.evaluate(() => (globalThis as unknown as { subagentIdleClock: IdleClock }).subagentIdleClock.reset()) }
      const target = { kind: 'model', sourceId: replacementId, modelId: 'o3' }
      if (change === 'profile-edit') expect((await assignmentCall(window, 'updateSubagentModel', { id: profile.id, expectedRevision: profile.revision, name: 'Idle verifier', description: 'Future only', target })).success).toBe(true)
      else if (change === 'profile-delete-recreate') {
        expect((await assignmentCall(window, 'deleteSubagentModel', { id: profile.id, expectedRevision: profile.revision })).success).toBe(true)
        expect((await assignmentCall(window, 'createSubagentModel', { name: 'Idle verifier', description: 'Different identity', target })).success).toBe(true)
      } else if (change === 'builtin-clear-rebind') {
        expect((await assignmentCall(window, 'clearBuiltinSubagentModel', { id: profile.id, expectedRevision: profile.revision })).success).toBe(true)
        const current = (await assignmentSettings(window)).profiles.find(item => item.id === profile.id)!
        expect((await assignmentCall(window, 'updateSubagentModel', { id: profile.id, expectedRevision: current.revision, description: 'Future only', target })).success).toBe(true)
      } else if (change === 'group-delete') expect((await window.evaluate(groupId => (globalThis as unknown as { halo: HaloAPI }).halo.aiGroupsDelete(groupId), groupId!)).success).toBe(true)
      else if (change === 'account-delete') expect((await window.evaluate(sourceId => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesDeleteSource(sourceId), sourceId)).success).toBe(true)
      else if (change === 'group-capability-shrink') expect((await window.evaluate(({ sourceId, groupId }) => (globalThis as unknown as { halo: HaloAPI }).halo.aiGroupsUpdate(groupId, { name: 'Idle binding pool', members: [{ sourceId, modelId: 'o3' }] }), { sourceId, groupId: groupId! })).success).toBe(true)
      else if (change === 'parent-change') {
        expect((await window.evaluate(conversationId => (globalThis as unknown as { halo: HaloAPI }).halo.updateConversation('halo-temp', conversationId, { modelSourceId: 'acceptance-local', modelId: 'o3', reasoningEffort: 'low' }), conversationId)).success).toBe(true)
      } else {
        const patch = change === 'credential-rotation' ? { apiKey: 'isolated-idle-rotated' } : change === 'same-account-endpoint-edit' ? { apiUrl: replacement.url } : { modelOverrides: { [targetModel]: { thinking: true, reasoningEffort: 'high', maxOutputTokens: 4096 } } }
        expect((await window.evaluate(({ sourceId, patch }) => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesUpdateSource(sourceId, patch), { sourceId, patch })).success).toBe(true)
      }
      resumed = true
      await securityConversation(window, 'IDLE_PARENT_FOLLOWUP: Continue the existing member.', conversationId)
      const rejected = ['account-delete', 'group-delete', 'capability-shrink', 'group-capability-shrink'].includes(change)
      if (rejected) {
        const category = change === 'account-delete' || change === 'group-delete' ? /account or group is unavailable/ : /reasoning|thinking|budget|unsupported|capabil/i
        await expect.poll(async () => (await window.evaluate(() => (globalThis as unknown as { acceptanceProbe: { errors: Array<{ conversationId: string; error: string }> } }).acceptanceProbe.errors)).some(error => error.conversationId.startsWith(`app-chat:${handle!}:team:`) && category.test(error.error)), { timeout: 60000 }).toBe(true)
        const errors = await window.evaluate(() => (globalThis as unknown as { acceptanceProbe: { errors: Array<{ conversationId: string; error: string }> } }).acceptanceProbe.errors)
        expect(errors.every(error => error.conversationId.startsWith(`app-chat:${handle!}:team:`) && category.test(error.error))).toBe(true)
        await waitForAcceptanceIdle(window, conversationId, { expectedErrors: errors })
        expect(requests).toHaveLength(before)
      } else {
        const continued = change === 'same-account-endpoint-edit' ? replacement.exchanges : endpoint.exchanges
        await expect.poll(() => continued.some(exchange => exchange.request.text.includes('IDLE_CHILD_FOLLOWUP')), { timeout: 60000 }).toBe(true)
        await waitForAcceptanceIdle(window, conversationId)
        expect(continued.some(exchange => exchange.request.text.includes('IDLE_ORIGINAL_HISTORY_CANARY') && exchange.request.text.includes('IDLE_CHILD_FOLLOWUP'))).toBe(true)
        expect(continued.filter(exchange => exchange.request.text.includes('IDLE_CHILD_FOLLOWUP')).every(exchange => exchange.request.body.model === targetModel && exchange.request.body.reasoning_effort === effort)).toBe(true)
        if (change === 'credential-rotation') expect(relay.authorizations.slice(before).every(value => value === 'Bearer isolated-idle-rotated')).toBe(true)
      }
      if (change !== 'same-account-endpoint-edit') expect(replacement.exchanges).toHaveLength(0)
      expect(parentRequests.some(request => initialUserInput(request).includes('IDLE_CHILD:'))).toBe(false)
      await info.attach('idle-retirement-evidence', { body: JSON.stringify({ change, handle, observations: await acceptanceApp.app.evaluate(() => ({ cleanup: (globalThis as unknown as { subagentIdleClock: IdleClock }).subagentIdleClock.observations(), sessions: (globalThis as unknown as { subagentIdleClock: IdleClock }).subagentIdleClock.sessions() })), original: endpoint.exchanges, replacement: replacement.exchanges }, null, 2), contentType: 'application/json' })
    } finally {
      await acceptanceApp.app.evaluate(() => (globalThis as unknown as { subagentIdleClock: IdleClock }).subagentIdleClock.reset())
      await relay.close()
      await endpoint.close()
      await replacement.close()
    }
  })
}
