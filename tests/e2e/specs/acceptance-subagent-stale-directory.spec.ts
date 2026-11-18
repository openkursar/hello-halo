import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { createModelGate, initialUserInput } from '../fixtures/acceptance-model'
import { assignmentCall } from '../fixtures/acceptance-subagent-models'
import { assignmentTool, assignmentResult } from '../fixtures/acceptance-subagent-wire'
import { securityConversation } from '../fixtures/acceptance-subagent-security'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'

test('an edited directory rejects its old cursor and issues a complete fresh page', acceptance('models.subagent-profiles.directory', { condition: 'stale-cursor' }), async ({ window, model }, info) => {
  test.setTimeout(180000)
  const gate = createModelGate()
  const errors: string[] = []
  const pages: any[] = []
  const refusals: string[] = []
  let held = false
  let handle: string | undefined
  let childRequests = 0
  model.respond(async request => {
    if (initialUserInput(request).includes('FRESH_DIRECTORY_CHILD:')) { childRequests++; return { text: 'fresh-directory-child-complete' } }
    const first = request.toolResults.find(result => result.id === 'cursor-first')
    if (!first) return assignmentTool(request, 'list_model_profiles', { limit: 1 }, 'cursor-first')
    const firstPage = assignmentResult(first.text)
    pages[0] = firstPage
    if (!held) { held = true; await gate.promise }
    const stale = request.toolResults.find(result => result.id === 'cursor-stale')
    if (!stale) return assignmentTool(request, 'list_model_profiles', { cursor: firstPage.nextCursor, limit: 1 }, 'cursor-stale')
    if (!refusals.length) refusals.push(stale.text)
    const fresh = request.toolResults.find(result => result.id === 'cursor-fresh')
    if (!fresh) return assignmentTool(request, 'list_model_profiles', { limit: 20 }, 'cursor-fresh')
    const freshPage = assignmentResult(fresh.text)
    pages[1] = freshPage
    const spawned = request.toolResults.find(result => result.id === 'cursor-spawn')
    if (!spawned) return assignmentTool(request, 'spawn_agent', { name: 'Fresh directory worker', prompt: 'FRESH_DIRECTORY_CHILD: Return fresh-directory-child-complete.', model_profile: freshPage.profiles[0].selectionRef }, 'cursor-spawn')
    try { handle = collaboratorReceipt(spawned).handle } catch (error) { errors.push(String(error)) }
    return { text: request.text.includes('fresh-directory-child-complete') ? 'fresh-directory-parent-complete' : 'Waiting for the fresh directory worker.' }
  })
  try {
    for (const name of ['Cursor first', 'Cursor second']) {
      const saved = await assignmentCall(window, 'createSubagentModel', { name, description: 'Original complete description', target: { kind: 'model', sourceId: 'acceptance-local', modelId: 'gpt-4o' } })
      expect(saved.success, saved.error).toBe(true)
    }
    const conversationId = await securityConversation(window, 'STALE_DIRECTORY_PARENT: Query once, then use the updated complete directory.')
    await expect.poll(() => held, { timeout: 60000 }).toBe(true)
    expect(pages[0].hasMore).toBe(true)
    expect(pages[0].nextCursor).toEqual(expect.any(String))
    const settings = await assignmentCall(window, 'listSubagentModels')
    expect(settings.success).toBe(true)
    const profile = settings.data!.profiles.find(profile => profile.kind === 'custom')!
    const changed = await assignmentCall(window, 'updateSubagentModel', { id: profile.id, expectedRevision: profile.revision, name: 'Cursor updated', description: 'Updated complete description', target: profile.target })
    expect(changed.success, changed.error).toBe(true)
    gate.release()
    await expect.poll(() => childRequests, { timeout: 90000 }).toBeGreaterThan(0)
    await expect.poll(() => model.exchanges.some(exchange => exchange.reply?.text === 'fresh-directory-parent-complete' && exchange.completed), { timeout: 90000 }).toBe(true)
    await waitForAcceptanceIdle(window, conversationId)
    expect(errors).toEqual([])
    expect(handle).toBeTruthy()
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatch(/cursor.*expired|start a new query/i)
    expect(pages[1].revision).not.toBe(pages[0].revision)
    expect(pages[1].hasMore).toBe(false)
    expect(pages[1].profiles.map((profile: { name: string }) => profile.name).sort()).toEqual(['Cursor second', 'Cursor updated'])
    expect(pages[1].profiles.find((profile: { name: string }) => profile.name === 'Cursor updated').description).toBe('Updated complete description')
    expect(Buffer.byteLength(JSON.stringify(pages[1]))).toBeLessThanOrEqual(16 * 1024)
    expect(model.errors).toEqual([])
    await info.attach('stale-directory-refusal', { body: JSON.stringify({ pages, refusals, handle, childRequests }, null, 2), contentType: 'application/json' })
  } finally { gate.release() }
})
