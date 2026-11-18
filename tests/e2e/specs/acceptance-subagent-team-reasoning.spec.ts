import { assertRequestedReasoning, waitForReasoningParentIdle, reasoningSource, reasoningVariants, selectedReasoning } from '../fixtures/acceptance-subagent-reasoning'
import { buildTeamSessionKey } from '../../../src/shared/apps/team-types'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import { installTeammate, createAwareTeam, memberTranscript } from '../fixtures/acceptance-team-awareness'
import { createEngineCollaborationScript, engineSourceQuestion, engineSourceAnswer, engineMemberAssignment } from '../fixtures/acceptance-engine-collaboration'
import { initialUserInput } from '../fixtures/acceptance-model'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const)
for (const reasoning of reasoningVariants(sdkEngine)) test.describe(`Team-private ${reasoning} delegation on ${sdkEngine}`, () => {
  test.use({ sdkEngine, diagnoseShutdown: true, aiSource: async ({ model }, use) => {
    await use(reasoningSource(model.url, reasoning))
  } })
  test('a standing member delegates with its own actual reasoning without adding a public member', acceptance('models.subagent-profiles.baseline-reasoning', { engine: sdkEngine, entry: 'team-member', reasoning }), async ({ window, model }, info) => {
    test.setTimeout(180000)
    const script = createEngineCollaborationScript()
    model.respond(request => {
      const initial = initialUserInput(request)
      if (!initial.includes(engineSourceQuestion) && !initial.includes(engineMemberAssignment)
        && request.text.includes('[System] Collaboration turn-end report.')) return { text: 'The private verification report is recorded.' }
      return script.reply(request)
    })
    await expect.poll(() => window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.appGetOverview().then(result => result.success)), { timeout: 30000 }).toBe(true)
    const coordinator = await installTeammate(window, 'halo-temp', 'Reasoning coordinator', 'Coordinate the isolated task.')
    const worker = await installTeammate(window, 'halo-temp', 'Reasoning standing member', 'Use a private collaborator when requested and report to the owner.')
    if (reasoning !== 'provider-default') {
      const configured = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({ appId: input.appId, overrides: { chatReasoningEffort: input.effort } }), { appId: worker, effort: selectedReasoning(reasoning)! })
      expect(configured.success, configured.error).toBe(true)
    }
    const aware = await createAwareTeam(window, { spaceId: 'halo-temp', name: 'Reasoning team', askerAppId: coordinator, askerRole: 'Coordinator', teammateAppId: worker, teammateRole: 'Verifier', intendedLabel: 'Reasoning work', unrelatedLabel: 'Unrelated work' })
    const before = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamGetDetail(id), aware.team.id)
    expect(before.success).toBe(true)
    const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.teamSendToMember(input), { teamId: aware.team.id, appId: worker, epochId: aware.intended.epochId, message: engineSourceQuestion, spaceId: 'halo-temp' })
    expect(sent.success, sent.error).toBe(true)
    await expect.poll(async () => (await memberTranscript(window, { appId: worker, spaceId: 'halo-temp', teamId: aware.team.id, epochId: aware.intended.epochId })).some(message => message.content.includes(engineSourceAnswer)), { timeout: 120000 }).toBe(true)
    expect(script.errors).toEqual([])
    expect(script.memberRequests.length).toBeGreaterThan(0)
    const wire = (body: Record<string, unknown>) => ({ model: body.model, reasoning_effort: body.reasoning_effort, reasoning: body.reasoning, thinking: body.thinking, output_config: body.output_config })
    expect(script.created?.handle).toBeTruthy()
    expect(script.followedUp).toBe(true)
    await waitForReasoningParentIdle(window, buildTeamSessionKey(worker, aware.team.id, aware.intended.epochId))
    const parent = wire(script.sourceRequests[0].body)
    assertRequestedReasoning(sdkEngine, reasoning, script.sourceRequests[0].body, 'team-member')
    assertRequestedReasoning(sdkEngine, reasoning, script.memberRequests[0].body, 'team-member')
    for (const request of script.memberRequests) expect(wire(request.body)).toEqual(parent)
    const after = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamGetDetail(id), aware.team.id)
    const members = (result: { data?: unknown }) => (result.data as { members: Array<{ appId: string }> }).members.map(member => member.appId).sort()
    expect(members(after)).toEqual(members(before))
    expect(members(after)).not.toContain(script.created!.handle)
    await info.attach('team-private-parent-reasoning', { body: JSON.stringify({ engine: sdkEngine, worker, child: script.created?.handle, parent, children: script.memberRequests.map(request => wire(request.body)) }, null, 2), contentType: 'application/json' })
  })
})
