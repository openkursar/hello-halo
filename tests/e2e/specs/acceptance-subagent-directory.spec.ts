import type { HaloAPI } from '../../../src/preload'
import { test, expect, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { seedDirectory, directoryScript } from '../fixtures/acceptance-subagent-directory'

for (const condition of ['large-catalog', 'unicode-injection', 'secret-canary'] as const) {
  test(`a bounded directory preserves complete nonsecret data for ${condition}`, {
    annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'models.subagent-profiles.directory', evidence: 'app-e2e', mode: 'scripted', variant: { condition } }) },
  }, async ({ window, model }, info) => {
    test.setTimeout(240000)
    const canary = 'directory-secret-canary-not-for-model'
    const updated = await window.evaluate(canary => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesUpdateSource('acceptance-local', { apiKey: canary }), canary)
    expect(updated.success, updated.error).toBe(true)
    const entries = await seedDirectory(window)
    const script = directoryScript()
    model.respond(script.reply)
    const created = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Directory traversal'))
    expect(created.success).toBe(true)
    const conversationId = (created.data as { id: string }).id
    const sent = await window.evaluate(conversationId => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage({ spaceId: 'halo-temp', conversationId, message: 'DIRECTORY_PARENT: Enumerate the configured directory and ask its last entry to verify.' }), conversationId)
    expect(sent.success, sent.error).toBe(true)
    await expect.poll(() => script.children.length, { timeout: 120000 }).toBeGreaterThan(0)
    await expect.poll(async () => {
      const history = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getConversation('halo-temp', id), conversationId)
      return (history.data as { messages: Array<{ content: string }> }).messages.some(message => message.content.includes('directory-parent-complete'))
    }, { timeout: 120000 }).toBe(true)
    await waitForAcceptanceIdle(window, conversationId)
    expect(script.errors).toEqual([])
    expect(script.handle).toBeTruthy()
    const profiles = script.pages.flatMap(page => page.profiles)
    expect(profiles.map(({ name, description }: { name: string; description: string }) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([...entries].sort((a, b) => a.name.localeCompare(b.name)))
    for (const page of script.pages) {
      expect(page.profiles.length).toBeLessThanOrEqual(20)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16 * 1024)
      for (const profile of page.profiles) expect(profile.selectionRef).toEqual(expect.any(String))
      const text = JSON.stringify(page)
      expect(text).not.toContain(canary)
      expect(text).not.toMatch(/"(?:sourceId|apiKey|headers|restoreRef)"/)
    }
    for (const exchange of model.exchanges) {
      expect(exchange.request.body.model).toBe('gpt-4o')
      expect(JSON.stringify(exchange.request.body)).not.toContain(canary)
    }
    expect(model.errors).toEqual([])
    await info.attach('complete-directory-pages', { body: JSON.stringify(script.pages, null, 2), contentType: 'application/json' })
  })
}
