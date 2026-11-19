import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import { installTeammate, createAwareTeam, memberTranscript } from '../fixtures/acceptance-team-awareness'
import { startAcceptanceModel } from '../fixtures/acceptance-model'
import { configureRoutingTarget, assignmentRoutingScript } from '../fixtures/acceptance-subagent-routing'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) test.describe(`Team-private assignment routing on ${sdkEngine}`, () => {
  test.use({ sdkEngine, diagnoseShutdown: true })
  test('a standing member sends its private assignment to the configured target', acceptance('models.subagent-profiles.owner-routing', { engine: sdkEngine, entry: 'team-member', choice: 'profile' }), async ({ window, model }, info) => {
    test.setTimeout(180000)
    const endpoint = await startAcceptanceModel()
    const script = assignmentRoutingScript()
    model.respond(script.parent)
    endpoint.respond(script.child)
    try {
      await expect.poll(() => window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.appGetOverview().then(result => result.success)), { timeout: 30000 }).toBe(true)
      await configureRoutingTarget(window, endpoint)
      const coordinator = await installTeammate(window, 'halo-temp', 'Assignment coordinator', 'Coordinate isolated work.')
      const worker = await installTeammate(window, 'halo-temp', 'Assignment standing member', 'Use Verifier when requested.')
      const aware = await createAwareTeam(window, { spaceId: 'halo-temp', name: 'Assignment team', askerAppId: coordinator, askerRole: 'Coordinator', teammateAppId: worker, teammateRole: 'Verifier', intendedLabel: 'Assigned work', unrelatedLabel: 'Unrelated work' })
      const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.teamSendToMember(input), { teamId: aware.team.id, appId: worker, epochId: aware.intended.epochId, message: 'Use the configured Verifier to check this work.', spaceId: 'halo-temp' })
      expect(sent.success, sent.error).toBe(true)
      await expect.poll(async () => (await memberTranscript(window, { appId: worker, spaceId: 'halo-temp', teamId: aware.team.id, epochId: aware.intended.epochId })).some(message => message.content.includes('The assignment returned assigned-target-confirmed.')), { timeout: 120000 }).toBe(true)
      expect(script.errors).toEqual([])
      expect(script.childRequests.length).toBeGreaterThan(0)
      expect(endpoint.errors).toEqual([])
      const detail = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamGetDetail(id), aware.team.id)
      expect((detail.data as { members: Array<{ appId: string }> }).members.map(member => member.appId).sort()).toEqual([coordinator, worker].sort())
      expect(script.handle).toBeTruthy()
    } finally {
      await info.attach('assigned-team-provider-exchanges', { body: JSON.stringify(endpoint.exchanges, null, 2), contentType: 'application/json' })
      await endpoint.close()
    }
  })
})
