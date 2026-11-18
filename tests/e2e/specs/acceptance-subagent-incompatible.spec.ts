import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_SUBSCRIPTION_MODELS, CLI_DELEGATED_PROVIDER_ID } from '../../../src/shared/constants/claude-models'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { startAcceptanceModel, createModelGate, initialUserInput } from '../fixtures/acceptance-model'
import { assignmentCall, assignmentSettings } from '../fixtures/acceptance-subagent-models'
import { assignmentTool, assignmentResult } from '../fixtures/acceptance-subagent-wire'
import { securityConversation } from '../fixtures/acceptance-subagent-security'
import { subagentEffects } from '../fixtures/acceptance-subagent-effects'

for (const target of ['non-cc-delegated', 'unsupported-effort', 'stale-reference', 'raw-model', 'raw-url', 'raw-account', 'unconfigured-slot'] as const) {
  test(`rejects ${target} before allocating collaborator effects`, acceptance('models.subagent-profiles.incompatible', { target }), async ({ window, model, acceptanceApp }, info) => {
    test.setTimeout(180000)
    let page = window
    const delegatedModel = Object.keys(CLAUDE_SUBSCRIPTION_MODELS)[0]
    const unused = await startAcceptanceModel()
    const gate = createModelGate()
    const results: string[] = []
    const children: number[] = []
    let held = false
    let reference: string | undefined
    model.respond(async request => {
      if (initialUserInput(request).includes('INVALID_TARGET_CHILD:')) {
        children.push(request.sequence)
        return { text: 'An invalid target unexpectedly ran.' }
      }
      const result = request.toolResults.find(result => result.id === 'invalid-target-spawn')
      if (result) { results.push(result.text); return { text: 'The invalid target was refused.' } }
      const listed = request.toolResults.find(result => result.id === 'invalid-target-directory')
      if (!listed) return assignmentTool(request, 'list_model_profiles', { query: 'Boundary target' }, 'invalid-target-directory')
      reference ??= assignmentResult(listed.text).profiles?.find((profile: { name: string }) => profile.name === 'Boundary target')?.selectionRef
      if (!reference) return { text: 'The test target is missing.' }
      if (!held) { held = true; await gate.promise }
      const input = target === 'raw-model' ? { model: 'arbitrary-wire-model' }
        : target === 'raw-url' ? { api_url: unused.url }
          : target === 'raw-account' ? { sourceId: 'arbitrary-account' }
            : target === 'unconfigured-slot' ? { model_profile: 'builtin:small' }
              : { model_profile: reference, ...(target === 'unsupported-effort' ? { reasoning_effort: 'not-a-supported-level' } : {}) }
      return assignmentTool(request, 'spawn_agent', { name: 'Invalid target worker', prompt: 'INVALID_TARGET_CHILD: This must never run.', ...input }, 'invalid-target-spawn')
    })
    try {
      if (target === 'non-cc-delegated') {
        page = await acceptanceApp.restart(profile => {
          const file = join(profile, '.halo/config.json')
          const config = JSON.parse(readFileSync(file, 'utf8'))
          // A persisted keyless account is sufficient for this rejection boundary; no CLI login is performed.
          config.aiSources.sources.push({
            id: 'boundary-delegated', name: 'Boundary delegated account', provider: CLI_DELEGATED_PROVIDER_ID,
            authType: 'delegated', apiUrl: '', user: { name: 'Fictional boundary account', uid: '' },
            model: delegatedModel, availableModels: Object.entries(CLAUDE_SUBSCRIPTION_MODELS).map(([id, name]) => ({ id, name })),
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          })
          config.aiSources.currentId = 'acceptance-local'
          writeFileSync(file, JSON.stringify(config))
        })
        const configuration = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getConfig())
        expect(configuration.success, configuration.error).toBe(true)
        expect((configuration.data as { aiSources: { currentId: string } }).aiSources.currentId).toBe('acceptance-local')
      }
      const saved = await assignmentCall(page, 'createSubagentModel', { name: 'Boundary target', description: 'A controlled invalid creation boundary',
        target: { kind: 'model', sourceId: target === 'non-cc-delegated' ? 'boundary-delegated' : 'acceptance-local', modelId: target === 'non-cc-delegated' ? delegatedModel : 'gpt-4o' } })
      expect(saved.success, saved.error).toBe(true)
      const conversationId = await securityConversation(page, 'INVALID_TARGET_PARENT: Attempt the provided invalid target once.')
      await expect.poll(() => held, { timeout: 60000 }).toBe(true)
      if (target === 'stale-reference') {
        const profile = (await assignmentSettings(page)).profiles.find(profile => profile.kind === 'custom')!
        const changed = await assignmentCall(page, 'updateSubagentModel', { id: profile.id, expectedRevision: profile.revision, name: 'Boundary target', description: 'Changed after the old reference was issued', target: profile.target })
        expect(changed.success, changed.error).toBe(true)
      }
      const before = subagentEffects(acceptanceApp.profile)
      gate.release()
      await expect.poll(() => results.length, { timeout: 60000 }).toBeGreaterThan(0)
      await waitForAcceptanceIdle(page, conversationId)
      expect(results.every(text => /unexpected|invalid|missing|changed|unsupported|not support|unavailable|refus|reject/i.test(text))).toBe(true)
      expect(subagentEffects(acceptanceApp.profile)).toEqual(before)
      expect(children).toEqual([])
      expect(unused.exchanges).toEqual([])
      expect(model.errors).toEqual([])
      await info.attach('invalid-target-zero-effects', { body: JSON.stringify({ target, results, before, after: subagentEffects(acceptanceApp.profile), providerRequests: unused.exchanges.length, childRequests: children.length }, null, 2), contentType: 'application/json' })
    } finally { gate.release(); await unused.close() }
  })
}
