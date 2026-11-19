import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { createModelGate, initialUserInput } from '../fixtures/acceptance-model'
import { assignmentCall } from '../fixtures/acceptance-subagent-models'
import { assignmentTool, parseModelDirectory, type ModelDirectory } from '../fixtures/acceptance-subagent-wire'
import { securityConversation } from '../fixtures/acceptance-subagent-security'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'

const originalName = 'Original verifier'
const retainedName = 'Retained verifier'
const updatedName = 'Updated verifier'

test('after an edit, an old selection ID is refused and a fresh directory ID works', acceptance('models.subagent-profiles.directory', { condition: 'stale-reference' }), async ({ window, model }, info) => {
  test.setTimeout(180000)
  const gate = createModelGate()
  const errors: string[] = []
  const unexpectedChildren: number[] = []
  let firstDirectory: ModelDirectory | undefined
  let freshDirectory: ModelDirectory | undefined
  let staleRefusal: string | undefined
  let held = false
  let handle: string | undefined
  let childRequests = 0
  model.respond(async request => {
    const actor = initialUserInput(request)
    if (actor.includes('FRESH_DIRECTORY_CHILD:')) { childRequests++; return { text: 'fresh-directory-child-complete' } }
    if (actor.includes('STALE_DIRECTORY_CHILD:')) {
      unexpectedChildren.push(request.sequence)
      return { text: 'The stale ID unexpectedly started a child.' }
    }
    const first = request.toolResults.find(result => result.id === 'original-directory')
    if (!first) return assignmentTool(request, 'list_model_profiles', {}, 'original-directory')
    try { firstDirectory = parseModelDirectory(first.text) } catch (error) { errors.push(String(error)); return { text: 'The original directory was invalid.' } }
    const oldReference = firstDirectory.profiles.find(profile => profile.name === originalName)?.selectionRef
    if (!oldReference) { errors.push('The original directory did not include a selectable verifier'); return { text: 'The original verifier was missing.' } }
    if (!held) { held = true; await gate.promise }
    const staleSpawn = request.toolResults.find(result => result.id === 'stale-directory-spawn')
    if (!staleSpawn) return assignmentTool(request, 'spawn_agent', { name: 'Stale directory worker', prompt: 'STALE_DIRECTORY_CHILD: Never run.', model_profile: oldReference }, 'stale-directory-spawn')
    staleRefusal = staleSpawn.text
    const fresh = request.toolResults.find(result => result.id === 'fresh-directory')
    if (!fresh) return assignmentTool(request, 'list_model_profiles', {}, 'fresh-directory')
    try { freshDirectory = parseModelDirectory(fresh.text) } catch (error) { errors.push(String(error)); return { text: 'The fresh directory was invalid.' } }
    const freshReference = freshDirectory.profiles.find(profile => profile.name === updatedName)?.selectionRef
    if (!freshReference) { errors.push('The fresh directory did not include a selectable verifier'); return { text: 'The updated verifier was missing.' } }
    const spawned = request.toolResults.find(result => result.id === 'fresh-directory-spawn')
    if (!spawned) return assignmentTool(request, 'spawn_agent', { name: 'Fresh directory worker', prompt: 'FRESH_DIRECTORY_CHILD: Return fresh-directory-child-complete.', model_profile: freshReference }, 'fresh-directory-spawn')
    try { handle = collaboratorReceipt(spawned).handle } catch (error) { errors.push(String(error)) }
    return { text: request.text.includes('fresh-directory-child-complete') ? 'fresh-directory-parent-complete' : 'Waiting for the fresh directory worker.' }
  })
  try {
    for (const name of [originalName, retainedName]) {
      const saved = await assignmentCall(window, 'createSubagentModel', { name, description: 'Original complete description', target: { kind: 'model', sourceId: 'acceptance-local', modelId: 'gpt-4o' } })
      expect(saved.success, saved.error).toBe(true)
    }
    const conversationId = await securityConversation(window, 'STALE_DIRECTORY_PARENT: List the configured assignments, then use the refreshed directory after an edit.')
    await expect.poll(() => held, { timeout: 60000 }).toBe(true)
    expect(firstDirectory?.profiles.map(profile => profile.name).sort()).toEqual([originalName, retainedName].sort())
    const oldReference = firstDirectory?.profiles.find(profile => profile.name === originalName)?.selectionRef
    expect(oldReference).toBeTruthy()
    const settings = await assignmentCall(window, 'listSubagentModels')
    expect(settings.success).toBe(true)
    const profile = settings.data!.profiles.find(profile => profile.kind === 'custom' && profile.name === originalName)!
    const changed = await assignmentCall(window, 'updateSubagentModel', { id: profile.id, expectedRevision: profile.revision, name: updatedName, description: 'Updated complete description', target: profile.target })
    expect(changed.success, changed.error).toBe(true)
    gate.release()
    await expect.poll(() => model.exchanges.some(exchange => exchange.reply?.text === 'fresh-directory-parent-complete' && exchange.completed), { timeout: 90000 }).toBe(true)
    await waitForAcceptanceIdle(window, conversationId)
    expect(errors).toEqual([])
    expect(handle).toBeTruthy()
    expect(childRequests).toBeGreaterThan(0)
    expect(staleRefusal).toMatch(/profile ID is no longer valid|list model profiles again/i)
    expect(unexpectedChildren).toEqual([])
    expect(freshDirectory?.profiles.map(profile => profile.name).sort()).toEqual([retainedName, updatedName].sort())
    expect(freshDirectory?.profiles.find(profile => profile.name === updatedName)?.description).toBe('Updated complete description')
    expect(freshDirectory?.profiles.map(profile => profile.selectionRef)).not.toContain(oldReference)
    expect(model.errors).toEqual([])
    await info.attach('stale-directory-refusal', { body: JSON.stringify({ firstDirectory, freshDirectory, staleRefusal, handle, childRequests, unexpectedChildren }, null, 2), contentType: 'application/json' })
  } finally { gate.release() }
})
