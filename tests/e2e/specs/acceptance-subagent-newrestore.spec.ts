import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { startAcceptanceModel, initialUserInput, type ModelRequest } from '../fixtures/acceptance-model'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { assignmentCall } from '../fixtures/acceptance-subagent-models'
import { addSecuritySource, securityConversation, securityTool } from '../fixtures/acceptance-subagent-security'
import { parseModelDirectory } from '../fixtures/acceptance-subagent-wire'

for (const change of ['capability-shrink', 'group-capability-shrink', 'parent-change'] as const) {
  test(`restored member revalidates ${change} without replacing its reasoning`, acceptance('models.subagent-profiles.restore', { change, boundary: 'restart' }), async ({ window, model, acceptanceApp }, info) => {
    test.setTimeout(180000)
    const endpoint = await startAcceptanceModel()
    const children: ModelRequest[] = []
    const parents: ModelRequest[] = []
    const results: string[] = []
    let handle: string | undefined
    let resumed = false
    endpoint.respond(request => {
      children.push(request)
      return { text: resumed ? 'RESTORED_REASONING_CONFIRMED' : 'ORIGINAL_REASONING_HISTORY_CANARY' }
    })
    model.respond(request => {
      parents.push(request)
      if (resumed) {
        const sent = request.toolResults.find(result => result.id === 'restore-followup')
        if (sent) { results.push(sent.text); return { text: 'RESTORE_DISPATCH_COMPLETE' } }
        return securityTool(request, 'team_send', { to: handle, message: 'RESTORE_FOLLOWUP: Retain your prior assignment and report its history.' }, 'restore-followup')
      }
      const created = request.toolResults.find(result => result.id === 'restore-spawn')
      if (created) { handle = collaboratorReceipt(created).handle; return { text: 'RESTORE_PARENT_READY' } }
      const catalog = request.toolResults.find(result => result.id === 'restore-catalog')
      if (!catalog) return securityTool(request, 'list_model_profiles', {}, 'restore-catalog')
      const reference = parseModelDirectory(catalog.text).profiles?.find((profile: { name: string }) => profile.name === 'Restore reasoning verifier')?.selectionRef
      if (!reference) return { text: 'RESTORE_PROFILE_MISSING' }
      return securityTool(request, 'spawn_agent', { name: 'Restore reasoning worker', prompt: 'RESTORE_CHILD: Remember this assignment across restoration.', model_profile: reference }, 'restore-spawn')
    })
    try {
      const targetModel = change === 'capability-shrink' ? 'claude-sonnet-4-5' : change === 'group-capability-shrink' ? 'gpt-6.1-sol' : 'o3'
      const targetEffort = change === 'group-capability-shrink' ? 'max' : 'high'
      const sourceId = await addSecuritySource(window, endpoint.url, 'Restore reasoning account', targetModel)
      const configured = await window.evaluate(({ sourceId, targetModel, targetEffort, nativeAnthropic }) => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesUpdateSource(sourceId, {
        ...(nativeAnthropic ? { provider: 'anthropic', apiType: 'anthropic_passthrough' } : {}),
        availableModels: [...new Set([targetModel, 'o3'])].map(id => ({ id, name: id })),
        modelOverrides: { [targetModel]: { thinking: true, reasoningEffort: targetEffort, maxOutputTokens: 32768 } },
      }), { sourceId, targetModel, targetEffort, nativeAnthropic: change === 'capability-shrink' })
      expect(configured.success, configured.error).toBe(true)
      let groupId: string | undefined
      if (change === 'group-capability-shrink') {
        const group = await window.evaluate(({ sourceId, targetModel }) => (globalThis as unknown as { halo: HaloAPI }).halo.aiGroupsCreate({ name: 'Restore capability pool', members: [{ sourceId, modelId: targetModel }] }), { sourceId, targetModel })
        expect(group.success, group.error).toBe(true)
        groupId = group.data!.groupId
      }
      const saved = await assignmentCall(window, 'createSubagentModel', { name: 'Restore reasoning verifier', description: 'Preserve exact reasoning through restore', target: groupId ? { kind: 'group', groupId } : { kind: 'model', sourceId, modelId: targetModel } })
      expect(saved.success, saved.error).toBe(true)
      const parentModel = change === 'group-capability-shrink' ? 'gpt-6.1-sol' : 'o3'
      const parentSource = await window.evaluate(model => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesUpdateSource('acceptance-local', {
        model, availableModels: [{ id: model, name: model }],
      }), parentModel)
      expect(parentSource.success, parentSource.error).toBe(true)
      const conversationId = await securityConversation(window, 'RESTORE_PARENT: Create the reasoning verifier once.', undefined, targetEffort)
      await expect.poll(() => Boolean(handle) && children.length > 0, { timeout: 90000 }).toBe(true)
      await waitForAcceptanceIdle(window, conversationId)
      expect(children.every(request => request.body.model === targetModel)).toBe(true)
      if (change === 'capability-shrink') {
        expect(children.every(request => request.body.thinking?.type === 'enabled' && request.body.thinking?.budget_tokens === 10240)).toBe(true)
      } else expect(children.every(request => request.body.reasoning_effort === targetEffort)).toBe(true)
      const before = children.length
      if (change === 'capability-shrink') {
        const shrunk = await window.evaluate(({ sourceId, targetModel }) => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesUpdateSource(sourceId, { modelOverrides: { [targetModel]: { thinking: true, reasoningEffort: 'high', maxOutputTokens: 4096 } } }), { sourceId, targetModel })
        expect(shrunk.success, shrunk.error).toBe(true)
      } else if (change === 'group-capability-shrink') {
        const shrunk = await window.evaluate(({ sourceId, groupId }) => (globalThis as unknown as { halo: HaloAPI }).halo.aiGroupsUpdate(groupId, { name: 'Restore capability pool', members: [{ sourceId, modelId: 'o3' }] }), { sourceId, groupId: groupId! })
        expect(shrunk.success, shrunk.error).toBe(true)
      } else {
        const changed = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesUpdateSource('acceptance-local', { model: 'o3', availableModels: [{ id: 'o3', name: 'o3' }], modelOverrides: { o3: { reasoningEffort: 'low' } } }))
        expect(changed.success, changed.error).toBe(true)
        const pinned = await window.evaluate(conversationId => (globalThis as unknown as { halo: HaloAPI }).halo.updateConversation('halo-temp', conversationId, { modelSourceId: 'acceptance-local', modelId: 'o3', reasoningEffort: 'low' }), conversationId)
        expect(pinned.success, pinned.error).toBe(true)
        const persisted = await window.evaluate(conversationId => (globalThis as unknown as { halo: HaloAPI }).halo.getConversation('halo-temp', conversationId), conversationId)
        expect(persisted.success, persisted.error).toBe(true)
        expect(persisted.data).toMatchObject({ modelSourceId: 'acceptance-local', modelId: 'o3', reasoningEffort: 'low' })
      }
      const parentsBefore = parents.length
      resumed = true
      const reopened = await acceptanceApp.restart()
      await securityConversation(reopened, 'RESTORE_PARENT_FOLLOWUP: Ask the existing member to continue.', conversationId)
      if (change === 'parent-change') {
        await expect.poll(() => children.length, { timeout: 90000 }).toBeGreaterThan(before)
        await waitForAcceptanceIdle(reopened, conversationId)
        expect(parents.slice(parentsBefore).some(request => request.text.includes('RESTORE_PARENT_FOLLOWUP:') && request.body.model === 'o3' && request.body.reasoning_effort === 'low')).toBe(true)
        const restored = children.slice(before)
        expect(restored.every(request => request.body.model === 'o3' && request.body.reasoning_effort === 'high')).toBe(true)
        expect(restored.some(request => request.text.includes('ORIGINAL_REASONING_HISTORY_CANARY') && request.text.includes('RESTORE_FOLLOWUP'))).toBe(true)
      } else {
        await expect.poll(() => reopened.evaluate(() => (globalThis as unknown as { acceptanceProbe: { errors: Array<{ conversationId: string; error: string }> } }).acceptanceProbe.errors), { timeout: 90000 }).toEqual(expect.arrayContaining([expect.objectContaining({ conversationId: expect.stringContaining(handle!), error: expect.stringMatching(/reasoning|thinking|budget|unsupported|capabil/i) })]))
        const observedErrors = await reopened.evaluate(() => (globalThis as unknown as { acceptanceProbe: { errors: Array<{ conversationId: string; error: string }> } }).acceptanceProbe.errors)
        const expectedErrors = observedErrors.filter(error => error.conversationId.startsWith(`app-chat:${handle!}:team:`) && /reasoning|thinking|budget|unsupported|capabil/i.test(error.error))
        expect(expectedErrors.length).toBeGreaterThan(0)
        expect(observedErrors).toEqual(expectedErrors)
        await waitForAcceptanceIdle(reopened, conversationId, { expectedErrors })
        expect(children).toHaveLength(before)
      }
      expect(parents.some(request => initialUserInput(request).includes('RESTORE_CHILD:'))).toBe(false)
      expect(handle).toBeTruthy()
    } finally {
      await info.attach('restored-reasoning-wire', { body: JSON.stringify({ change, handle, children: endpoint.exchanges, results }, null, 2), contentType: 'application/json' })
      await endpoint.close()
    }
  })
}
