import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { seedDirectory, directoryScript, unavailableDirectoryName } from '../fixtures/acceptance-subagent-directory'
import { assignmentCall } from '../fixtures/acceptance-subagent-models'
import { assignmentTool } from '../fixtures/acceptance-subagent-wire'
import { securityConversation } from '../fixtures/acceptance-subagent-security'

for (const condition of ['large-catalog', 'unicode-injection', 'secret-canary'] as const) {
  test(`one call returns the complete nonsecret directory for ${condition}`, acceptance('models.subagent-profiles.directory', { condition }), async ({ window, model }, info) => {
    test.setTimeout(240000)
    const canary = 'directory-secret-canary-not-for-model'
    const updated = await window.evaluate(canary => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesUpdateSource('acceptance-local', { apiKey: canary }), canary)
    expect(updated.success, updated.error).toBe(true)
    const entries = await seedDirectory(window, model.url)
    const script = directoryScript(entries.at(-2)!.name)
    model.respond(script.reply)
    const conversationId = await securityConversation(window, 'DIRECTORY_PARENT: List all configured assignments and ask the last available entry to verify.')
    await expect.poll(() => model.exchanges.some(exchange => exchange.completed && exchange.reply?.text === 'directory-parent-complete'), { timeout: 120000 }).toBe(true)
    await waitForAcceptanceIdle(window, conversationId)
    expect(script.errors).toEqual([])
    expect(script.handle).toBeTruthy()
    expect(script.children.length).toBeGreaterThan(0)
    const directory = script.directory!
    const { profiles } = directory
    expect(profiles.map(({ name, description }) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([...entries].sort((a, b) => a.name.localeCompare(b.name)))
    const available = profiles.filter(profile => profile.name !== unavailableDirectoryName)
    expect(new Set(available.map(profile => profile.selectionRef)).size).toBe(available.length)
    const unavailable = profiles.find(profile => profile.name === unavailableDirectoryName)
    expect(unavailable?.unavailableReason).toMatch(/model account was removed/i)
    expect(unavailable?.selectionRef).toBeUndefined()
    expect(Buffer.byteLength(directory.text)).toBeLessThanOrEqual(16 * 1024)
    for (const profile of profiles) expect(profile.target).toEqual({ kind: 'model', label: expect.stringContaining('gpt-4o') })
    for (const profile of available) {
      expect(profile.selectionRef).toEqual(expect.any(String))
      expect(profile.unavailableReason).toBeUndefined()
    }
    expect(directory.text).not.toContain(canary)
    expect(directory.text).not.toMatch(/acceptance-local|sourceId|apiKey|headers|restoreRef|https?:\/\//)
    const listCalls = model.exchanges.flatMap(exchange => exchange.reply?.tools ?? []).filter(tool => tool.name.endsWith('list_model_profiles'))
    expect(listCalls).toEqual([expect.objectContaining({ input: {} })])
    for (const exchange of model.exchanges) {
      expect(exchange.request.body.model).toBe('gpt-4o')
      expect(JSON.stringify(exchange.request.body)).not.toContain(canary)
    }
    expect(model.errors).toEqual([])
    await info.attach('complete-directory', { body: JSON.stringify(directory, null, 2), contentType: 'application/json' })
  })
}

test('an oversized directory returns an explicit error without partial entries', acceptance('models.subagent-profiles.directory', { condition: 'oversized-catalog' }), async ({ window, model }, info) => {
  const description = '验证'.repeat(350)
  const names = Array.from({ length: 10 }, (_, index) => `Oversized directory entry ${index}`)
  expect(Buffer.byteLength(description) * names.length).toBeGreaterThan(16 * 1024)
  for (const name of names) {
    const saved = await assignmentCall(window, 'createSubagentModel', { name, description, target: { kind: 'model', sourceId: 'acceptance-local', modelId: 'gpt-4o' } })
    expect(saved.success, saved.error).toBe(true)
  }
  const results: string[] = []
  model.respond(request => {
    const listed = request.toolResults.find(result => result.id === 'oversized-directory')
    if (!listed) return assignmentTool(request, 'list_model_profiles', {}, 'oversized-directory')
    results.push(listed.text)
    return { text: 'The oversized directory response was received.' }
  })
  const conversationId = await securityConversation(window, 'OVERSIZED_DIRECTORY_PARENT: List the configured assignments.')
  await expect.poll(() => results.length, { timeout: 60000 }).toBeGreaterThan(0)
  await waitForAcceptanceIdle(window, conversationId)
  expect(results).toHaveLength(1)
  expect(results[0]).toMatch(/(?:directory|catalog).*(?:too large|exceeds|size limit)/i)
  expect(results[0]).not.toMatch(/model_profile:|验证/)
  for (const name of names) expect(results[0]).not.toContain(name)
  expect(model.errors).toEqual([])
  await info.attach('oversized-directory-refusal', { body: results[0], contentType: 'text/plain' })
})
