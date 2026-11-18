import type { HaloAPI } from '../../../src/preload'
import { buildTeamSessionKey } from '../../../src/shared/apps/team-types'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import { installTeammate, createAwareTeam, memberTranscript } from '../fixtures/acceptance-team-awareness'
import { waitForReasoningParentIdle } from '../fixtures/acceptance-subagent-reasoning'
import { prepareOwnerChoice, ownerChoiceScript, assertOwnerChoiceWire, assertOwnerFailure } from '../fixtures/acceptance-subagent-owner-choices'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) test.describe(`Standing member owner choices on ${sdkEngine}`, () => {
  test.use({ sdkEngine, aiSource: async ({ model }, use) => {
    await use({ provider: 'openai', apiType: 'chat_completions', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'o3' })
  } })
  for (const choice of ['inherit', 'effort-only', 'provider-failure'] as const) test(`a standing member reviews ${choice}`, acceptance('models.subagent-profiles.owner-routing', { engine: sdkEngine, entry: 'team-member', choice }), async ({ window, model }, info) => {
    test.setTimeout(180000)
    const endpoint = await prepareOwnerChoice(window, choice)
    const script = ownerChoiceScript(choice)
    model.respond(request => {
      if (request.text.includes('[System] Collaboration turn-end report.') && !request.text.includes(script.marker)) return { text: 'Private owner choice recorded.' }
      return script.reply(request)
    })
    try {
      await expect.poll(() => window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.appGetOverview().then(result => result.success)), { timeout: 30000 }).toBe(true)
      const coordinator = await installTeammate(window, 'halo-temp', 'Owner choice coordinator', 'Coordinate isolated work.')
      const worker = await installTeammate(window, 'halo-temp', 'Owner choice standing member', 'Review delegated work before replying.')
      const overridden = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({ appId, overrides: { chatReasoningEffort: 'high' } }), worker)
      expect(overridden.success, overridden.error).toBe(true)
      const aware = await createAwareTeam(window, { spaceId: 'halo-temp', name: 'Owner choice team', askerAppId: coordinator, askerRole: 'Coordinator', teammateAppId: worker, teammateRole: 'Verifier', intendedLabel: 'Owner choice work', unrelatedLabel: 'Unrelated work' })
      const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.teamSendToMember(input), { teamId: aware.team.id, appId: worker, epochId: aware.intended.epochId, message: script.marker, spaceId: 'halo-temp' })
      expect(sent.success, sent.error).toBe(true)
      await expect.poll(async () => (await memberTranscript(window, { appId: worker, spaceId: 'halo-temp', teamId: aware.team.id, epochId: aware.intended.epochId })).some(message => message.content.includes('owner-choice-parent-complete')), { timeout: 120000 }).toBe(true)
      await waitForReasoningParentIdle(window, buildTeamSessionKey(worker, aware.team.id, aware.intended.epochId))
      assertOwnerChoiceWire(script, choice)
      assertOwnerFailure(endpoint, script)
      const detail = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamGetDetail(id), aware.team.id)
      expect((detail.data as { members: Array<{ appId: string }> }).members.map(member => member.appId).sort()).toEqual([coordinator, worker].sort())
      expect(model.errors).toEqual([])
      await info.attach('owner-team-choice', { body: JSON.stringify({ parents: script.parents, children: script.children, rejected: endpoint?.requests }, null, 2), contentType: 'application/json' })
    } finally { await endpoint?.close() }
  })
})
