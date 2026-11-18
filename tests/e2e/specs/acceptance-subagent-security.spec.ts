import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { startAcceptanceModel, createModelGate, initialUserInput, type ModelRequest } from '../fixtures/acceptance-model'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { test as guestTest, GUEST_ID, changeGuestPolicy, waitForGuestChannel, waitForImIdle, imTranscript } from '../fixtures/acceptance-guest'
import { assignmentCall, assignmentSettings } from '../fixtures/acceptance-subagent-models'
import { addSecuritySource, decodeSecurityResult, refusedSecurityResult, securityConversation, securityTool, securityCredentialRelay } from '../fixtures/acceptance-subagent-security'

for (const change of ['profile-edit', 'profile-delete-recreate', 'builtin-clear-rebind', 'credential-rotation', 'same-account-endpoint-edit', 'account-delete', 'group-delete'] as const) {
  test(`existing binding remains exact after ${change} and restart`, acceptance('models.subagent-profiles.restore', { change, boundary: 'restart' }), async ({ window, model, acceptanceApp }, info) => {
    test.setTimeout(180000)
    const original = await startAcceptanceModel()
    const replacement = await startAcceptanceModel()
    const relay = await securityCredentialRelay(original.url)
    let handle: string | undefined
    let reference: string | undefined
    let resumed = false
    const errors: string[] = []
    const originalRequests: ModelRequest[] = []
    const sourceRequests: ModelRequest[] = []
    const refusalResults: string[] = []
    original.respond(request => { originalRequests.push(request); return { text: resumed ? 'ORIGINAL_BINDING_FOLLOWUP_CONFIRMED' : 'ORIGINAL_BINDING_READY' } })
    replacement.respond(() => ({ text: change === 'same-account-endpoint-edit' ? 'EDITED_ENDPOINT_FOLLOWUP_CONFIRMED' : 'WRONG_REPLACEMENT_BINDING' }))
    model.respond(request => {
      sourceRequests.push(request)
      if (initialUserInput(request).includes('BOUND_MEMBER:')) {
        errors.push('A bound member fell back to the global endpoint')
        return { text: 'WRONG_GLOBAL_BINDING' }
      }
      const sent = request.toolResults.find(result => result.id === 'binding-followup')
      if (resumed) {
        if (sent) {
          refusalResults.push(sent.text)
          return { text: 'BINDING_FOLLOWUP_DISPATCHED' }
        }
        return securityTool(request, 'team_send', { to: handle, message: 'BOUND_MEMBER_FOLLOWUP: Report your original assignment.' }, 'binding-followup')
      }
      const created = request.toolResults.find(result => result.id === 'binding-spawn')
      if (created) {
        try { handle = collaboratorReceipt(created).handle } catch (error) { errors.push(String(error)) }
        return { text: 'BOUND_PARENT_READY' }
      }
      const catalog = request.toolResults.find(result => result.id === 'binding-directory')
      if (!catalog) return securityTool(request, 'list_model_profiles', { query: 'Bound verifier' }, 'binding-directory')
      try { reference = decodeSecurityResult(catalog.text).profiles?.find((profile: { name: string }) => (profile.name === 'Bound verifier' || change === 'builtin-clear-rebind' && profile.name === 'Small (小杯)'))?.selectionRef }
      catch (error) { errors.push(String(error)) }
      if (!reference) { errors.push('No exact profile reference'); return { text: 'No bound verifier.' } }
      return securityTool(request, 'spawn_agent', { name: 'Bound verifier worker', prompt: 'BOUND_MEMBER: Retain the original binding.', model_profile: reference }, 'binding-spawn')
    })
    try {
      const originalId = await addSecuritySource(window, relay.url, 'Original strict account')
      const replacementId = await addSecuritySource(window, replacement.url, 'Replacement strict account')
      let groupId: string | undefined
      if (change === 'group-delete') {
        const group = await window.evaluate(sourceId => (globalThis as unknown as { halo: HaloAPI }).halo.aiGroupsCreate({ name: 'Strict binding group', members: [{ sourceId, modelId: 'gpt-4o' }] }), originalId)
        expect(group.success, group.error).toBe(true)
        groupId = group.data!.groupId
      }
      const initialSettings = await assignmentSettings(window)
      const builtin = initialSettings.profiles.find(profile => profile.id === 'builtin:small')!
      const saved = await assignmentCall(window, change === 'builtin-clear-rebind' ? 'updateSubagentModel' : 'createSubagentModel', {
        ...(change === 'builtin-clear-rebind' ? { id: builtin.id, expectedRevision: builtin.revision } : { name: 'Bound verifier' }),
        description: 'Bound verifier: Retain exact target', target: groupId ? { kind: 'group', groupId } : { kind: 'model', sourceId: originalId, modelId: 'gpt-4o' },
      })
      expect(saved.success, saved.error).toBe(true)
      const profile = saved.data!.profiles.find(profile => change === 'builtin-clear-rebind' ? profile.id === builtin.id : profile.kind === 'custom' && profile.name === 'Bound verifier')!
      const conversationId = await securityConversation(window, 'BOUND_PARENT: Create the bound verifier once.')
      await expect.poll(() => Boolean(handle) && originalRequests.length > 0, { timeout: 90000 }).toBe(true)
      await waitForAcceptanceIdle(window, conversationId)
      if (change === 'profile-edit') {
        const updated = await assignmentCall(window, 'updateSubagentModel', { id: profile.id, expectedRevision: profile.revision, name: 'Bound verifier', description: 'New target for future work only', target: { kind: 'model', sourceId: replacementId, modelId: 'gpt-4o' } })
        expect(updated.success, updated.error).toBe(true)
      } else if (change === 'profile-delete-recreate') {
        expect((await assignmentCall(window, 'deleteSubagentModel', { id: profile.id, expectedRevision: profile.revision })).success).toBe(true)
        expect((await assignmentCall(window, 'createSubagentModel', { name: 'Bound verifier', description: 'A different identity', target: { kind: 'model', sourceId: replacementId, modelId: 'gpt-4o' } })).success).toBe(true)
      } else if (change === 'builtin-clear-rebind') {
        const cleared = await assignmentCall(window, 'clearBuiltinSubagentModel', { id: profile.id, expectedRevision: profile.revision })
        expect(cleared.success, cleared.error).toBe(true)
        const current = cleared.data!.profiles.find(item => item.id === profile.id)!
        const rebound = await assignmentCall(window, 'updateSubagentModel', { id: current.id, expectedRevision: current.revision, description: 'Bound verifier new target', target: { kind: 'model', sourceId: replacementId, modelId: 'gpt-4o' } })
        expect(rebound.success, rebound.error).toBe(true)
      } else if (change === 'credential-rotation' || change === 'same-account-endpoint-edit') {
        const updated = await window.evaluate(({ originalId, change, url }) => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesUpdateSource(originalId,
          change === 'credential-rotation' ? { apiKey: 'isolated-rotated-credential' } : { apiUrl: url }), { originalId, change, url: replacement.url })
        expect(updated.success, updated.error).toBe(true)
      } else {
        const removed = await window.evaluate(({ change, originalId, groupId }) => {
          const api = (globalThis as unknown as { halo: HaloAPI }).halo
          return change === 'account-delete' ? api.aiSourcesDeleteSource(originalId) : api.aiGroupsDelete(groupId!)
        }, { change, originalId, groupId })
        expect(removed.success, removed.error).toBe(true)
      }
      const before = originalRequests.length
      resumed = true
      const reopened = await acceptanceApp.restart()
      await securityConversation(reopened, 'BOUND_PARENT_RESUME: Send a follow-up to the existing member; never create a new member.', conversationId)
      const revoked = change === 'account-delete' || change === 'group-delete'
      await expect.poll(() => refusalResults.length > 0 || originalRequests.length > before, { timeout: 90000 }).toBe(true)
      if (revoked) {
        const expectedErrors = await reopened.evaluate(() => (globalThis as unknown as { acceptanceProbe: { errors: Array<{ conversationId: string; error: string }> } }).acceptanceProbe.errors)
        expect(expectedErrors.length).toBeGreaterThan(0)
        expect(expectedErrors.every(error => error.conversationId.includes(handle!) && /account or group is unavailable/.test(error.error))).toBe(true)
        await waitForAcceptanceIdle(reopened, conversationId, { expectedErrors })
      } else await waitForAcceptanceIdle(reopened, conversationId)
      if (revoked) {
        expect(originalRequests).toHaveLength(before)
        const failures = await reopened.evaluate(() => (globalThis as unknown as { acceptanceProbe: { errors: Array<{ error: string }> } }).acceptanceProbe.errors)
        expect(failures.some(error => /delegated model account or group is unavailable/.test(error.error))).toBe(true)
      } else if (change === 'same-account-endpoint-edit') {
        await expect.poll(() => replacement.exchanges.length, { timeout: 60000 }).toBeGreaterThan(0)
        expect(replacement.exchanges.some(exchange => exchange.request.text.includes('BOUND_MEMBER_FOLLOWUP'))).toBe(true)
        expect(originalRequests).toHaveLength(before)
      } else {
        await expect.poll(() => originalRequests.length, { timeout: 60000 }).toBeGreaterThan(before)
        expect(originalRequests.slice(before).some(request => request.text.includes('BOUND_MEMBER_FOLLOWUP'))).toBe(true)
        if (change === 'credential-rotation') {
          expect(relay.authorizations.slice(0, before).every(value => value === 'Bearer isolated-security-fixture')).toBe(true)
          expect(relay.authorizations.slice(before).length).toBeGreaterThan(0)
          expect(relay.authorizations.slice(before).every(value => value === 'Bearer isolated-rotated-credential')).toBe(true)
        }
      }
      if (change !== 'same-account-endpoint-edit') expect(replacement.exchanges).toHaveLength(0)
      expect(errors).toEqual([])
      expect(sourceRequests.some(request => initialUserInput(request).includes('BOUND_MEMBER:'))).toBe(false)
    } finally {
      await info.attach('strict-binding-endpoints', { body: JSON.stringify({ change, handle, original: original.exchanges, replacement: replacement.exchanges, refusalResults, errors }, null, 2), contentType: 'application/json' })
      await relay.close()
      await original.close()
      await replacement.close()
    }
  })
}

for (const requestKind of ['directory', 'profile', 'effort-only', 'inherit'] as const) {
  guestTest(`guest ${requestKind} retains the restricted model authority`, acceptance('models.subagent-profiles.origin', { origin: 'guest-im', request: requestKind }), async ({ window, model, guestApp, wecom }, info) => {
    guestTest.setTimeout(180000)
    const results: string[] = []
    const parentRequests: ModelRequest[] = []
    const children: ModelRequest[] = []
    let attempted = false
    let ownerReference: string | undefined
    model.respond(request => {
      if (initialUserInput(request).includes('OWNER_REFERENCE_CAPTURE:')) {
        const catalog = request.toolResults.find(result => result.id === 'owner-reference-directory')
        if (!catalog) return securityTool(request, 'list_model_profiles', {}, 'owner-reference-directory')
        ownerReference = decodeSecurityResult(catalog.text).profiles?.find((profile: { name: string }) => profile.name === 'Private owner assignment')?.selectionRef
        return { text: 'OWNER_REFERENCE_CAPTURED' }
      }
      if (initialUserInput(request).includes('GUEST_BOUND_CHILD:')) { children.push(request); return { text: 'GUEST_INHERIT_CONFIRMED' } }
      parentRequests.push(request)
      const result = request.toolResults.find(result => result.id === 'guest-bound-attempt')
      if (result) { results.push(result.text); return { text: 'GUEST_BOUND_CHECK_COMPLETE' } }
      if (attempted) return { text: 'GUEST_BOUND_CHECK_COMPLETE' }
      if (requestKind === 'directory') {
        attempted = true
        return { tools: [{ id: 'guest-bound-attempt', name: 'mcp__halo-team__list_model_profiles', input: {} }] }
      }
      const input = requestKind === 'profile' ? { model_profile: ownerReference } : requestKind === 'effort-only' ? { reasoning_effort: 'high' } : {}
      const reply = securityTool(request, 'spawn_agent', { name: 'Guest inherited worker', prompt: 'GUEST_BOUND_CHILD: Answer within the guest authority.', ...input }, 'guest-bound-attempt')
      attempted = reply.tools?.[0]?.id === 'guest-bound-attempt'
      return reply
    })
    const saved = await assignmentCall(window, 'createSubagentModel', { name: 'Private owner assignment', description: 'OWNER_ASSIGNMENT_SECRET_CANARY', target: { kind: 'model', sourceId: 'acceptance-local', modelId: 'gpt-4o' } })
    expect(saved.success, saved.error).toBe(true)
    const ownerConversation = await securityConversation(window, 'OWNER_REFERENCE_CAPTURE: Read the private assignment directory.')
    await expect.poll(() => Boolean(ownerReference), { timeout: 60000 }).toBe(true)
    await waitForAcceptanceIdle(window, ownerConversation)
    await changeGuestPolicy(window, guestApp, wecom, { notifications: false })
    const granted = await window.evaluate(instanceId => (globalThis as unknown as { halo: HaloAPI }).halo.imChannelsUpdateInstance(instanceId, { guestPolicy: { allowedTools: [], allowCollaboration: true } }), guestApp.instanceId)
    expect(granted.success, granted.error).toBe(true)
    await waitForGuestChannel(window, guestApp, wecom)
    const sent = await wecom.sendText({ senderId: GUEST_ID, senderName: 'Isolated guest', chatId: GUEST_ID, chatType: 'direct', text: `GUEST_BOUND_PARENT: Check ${requestKind} without owner authority.` })
    const reply = await wecom.waitForReply({ requestId: sent.requestId })
    await waitForImIdle(window, guestApp, GUEST_ID)
    expect(attempted).toBe(true)
    expect(parentRequests.length).toBeGreaterThan(0)
    for (const request of parentRequests) {
      expect(request.tools.some(name => name.endsWith('list_model_profiles'))).toBe(false)
      expect(request.text).not.toContain('OWNER_ASSIGNMENT_SECRET_CANARY')
      expect(request.text).not.toContain('Private owner assignment')
    }
    if (requestKind === 'inherit') {
      expect(results).toHaveLength(1)
      expect(collaboratorReceipt({ id: 'guest-bound-attempt', text: results[0], error: false }).status).toBe('accepted')
      await expect.poll(() => children.length, { timeout: 60000 }).toBeGreaterThan(0)
      for (const child of children) {
        expect(child.body.model).toBe(parentRequests[0].body.model)
        expect(child.body.reasoning_effort).toEqual(parentRequests[0].body.reasoning_effort)
      }
    } else {
      expect(children).toHaveLength(0)
      expect(refusedSecurityResult(results[0] ?? reply.text)).toBe(true)
    }
    const transcript = await imTranscript(window, guestApp, GUEST_ID)
    expect(JSON.stringify(transcript.messages)).not.toContain('restoreRef')
    expect(JSON.stringify(transcript.messages)).not.toContain('isolated-security-fixture')
    await info.attach('guest-model-authority', { body: JSON.stringify({ requestKind, results, reply: reply.text, childCount: children.length }, null, 2), contentType: 'application/json' })
  })
}

for (const change of ['task-to-inherit', 'inherit-to-task'] as const) {
  test(`obsolete ${change} endpoint refuses directory and all overrides but permits pure inheritance`, acceptance('models.subagent-profiles.policy-race', { change }), async ({ window, model }, info) => {
    test.setTimeout(180000)
    const gate = createModelGate()
    let held = false
    let reference: string | undefined
    const results = new Map<string, string>()
    const children: ModelRequest[] = []
    const attempts = ['stale-directory', 'stale-profile', 'stale-effort', 'stale-explicit-inherit-effort', 'pure-inherit']
    model.respond(async request => {
      if (initialUserInput(request).includes('POLICY_CHILD:')) { children.push(request); return { text: 'PURE_INHERIT_CHILD_CONFIRMED' } }
      const catalog = request.toolResults.find(result => result.id === 'policy-catalog')
      if (!catalog) return securityTool(request, 'list_model_profiles', {}, 'policy-catalog')
      reference ??= decodeSecurityResult(catalog.text).profiles?.[0]?.selectionRef
      if (!held) { held = true; await gate.promise }
      for (const id of attempts) {
        const result = request.toolResults.find(result => result.id === id)
        if (result) { results.set(id, result.text); continue }
        if (id === 'stale-directory') return securityTool(request, 'list_model_profiles', {}, id)
        const input = id === 'stale-profile' ? { model_profile: reference }
          : id === 'stale-effort' ? { reasoning_effort: 'high' }
            : id === 'stale-explicit-inherit-effort' ? { model_profile: 'inherit', reasoning_effort: 'high' } : {}
        return securityTool(request, 'spawn_agent', { name: id, prompt: `POLICY_CHILD: ${id}`, ...input }, id)
      }
      return { text: 'POLICY_CHECK_COMPLETE' }
    })
    try {
      const bound = await assignmentCall(window, 'createSubagentModel', { name: 'Policy verifier', description: 'A policy race target', target: { kind: 'model', sourceId: 'acceptance-local', modelId: 'gpt-4o' } })
      expect(bound.success, bound.error).toBe(true)
      if (change === 'task-to-inherit') {
        const settings = await assignmentSettings(window)
        expect((await assignmentCall(window, 'setSubagentModelSelectionMode', { selectionMode: 'task', expectedRevision: settings.revision })).success).toBe(true)
      }
      const conversationId = await securityConversation(window, 'POLICY_PARENT: Exercise the held selection endpoint.')
      await expect.poll(() => held, { timeout: 60000 }).toBe(true)
      expect(reference).toBeTruthy()
      const settings = await assignmentSettings(window)
      const updated = await assignmentCall(window, 'setSubagentModelSelectionMode', { selectionMode: change === 'task-to-inherit' ? 'inherit' : 'task', expectedRevision: settings.revision })
      expect(updated.success, updated.error).toBe(true)
      gate.release()
      await expect.poll(() => results.size, { timeout: 90000 }).toBe(attempts.length)
      await waitForAcceptanceIdle(window, conversationId)
      for (const id of attempts.slice(0, -1)) expect(refusedSecurityResult(results.get(id)!), id).toBe(true)
      expect(collaboratorReceipt({ id: 'pure-inherit', text: results.get('pure-inherit')!, error: false }).status).toBe('accepted')
      await expect.poll(() => children.length, { timeout: 30000 }).toBeGreaterThan(0)
      expect(children.every(request => initialUserInput(request).includes('POLICY_CHILD: pure-inherit'))).toBe(true)
      await info.attach('stale-policy-refusals', { body: JSON.stringify({ change, results: Object.fromEntries(results), children: children.map(request => request.sequence) }, null, 2), contentType: 'application/json' })
    } finally { gate.release() }
  })
}
