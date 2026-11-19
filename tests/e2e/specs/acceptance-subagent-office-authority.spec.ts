import { randomUUID } from 'node:crypto'
import { buildTeamSessionKey } from '../../../src/shared/apps/im-keys'
import { acceptance, expect, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { test, officeWorkspaceDirectories, type OfficeNode } from '../fixtures/acceptance-subagent-office'
import { installTeammate, createAwareTeam } from '../fixtures/acceptance-team-awareness'
import { createModelGate, initialUserInput, type ModelRequest } from '../fixtures/acceptance-model'
import { securityTool, refusedSecurityResult } from '../fixtures/acceptance-subagent-security'
import { parseModelDirectory } from '../fixtures/acceptance-subagent-wire'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'

for (const requestKind of ['inherit', 'profile', 'removed-effort', 'directory'] as const) {
  test(`remote office ${requestKind} retains the member owner's model authority`, acceptance('models.subagent-profiles.origin', { origin: 'remote-office', request: requestKind }), async ({ officeNodes, model }, info) => {
    test.setTimeout(300000)
    const { authority, owner, observer, ownerModel } = officeNodes
    const marker = randomUUID()
    const parentRequests: ModelRequest[] = []
    const children: ModelRequest[] = []
    const results: string[] = []
    let reference: string | undefined
    let attempted = false
    let parentHeld = false
    const parentGate = createModelGate()
    model.respond(() => ({ text: 'AUTHORITY_IDLE' }))
    ownerModel.respond(async request => {
      if (initialUserInput(request).includes(`OWNER_CAPTURE_${marker}`)) {
        const result = request.toolResults.find(result => result.id === 'owner-directory')
        if (!result) return securityTool(request, 'list_model_profiles', {}, 'owner-directory')
        reference = parseModelDirectory(result.text).profiles?.find((profile: { name: string }) => profile.name === 'Private remote assignment')?.selectionRef
        return { text: `OWNER_CAPTURED_${marker}` }
      }
      if (initialUserInput(request).includes(`REMOTE_CHILD_${marker}`)) { children.push(request); return { text: `REMOTE_CHILD_CONFIRMED_${marker}` } }
      if (!request.text.includes(`REMOTE_PARENT_${marker}`)) return { text: 'OBSERVER_IDLE' }
      parentRequests.push(request)
      if (!parentHeld) {
        parentHeld = true
        await parentGate.promise
      }
      const result = request.toolResults.find(result => result.id === 'remote-attempt')
      if (result) { results.push(result.text); return { text: `REMOTE_FINISHED_${marker}` } }
      if (attempted) return { text: `REMOTE_FINISHED_${marker}` }
      if (requestKind === 'directory') {
        attempted = true
        return { tools: [{ id: 'remote-attempt', name: 'mcp__halo-team__list_model_profiles', input: {} }] }
      }
      const input = requestKind === 'profile' ? { model_profile: reference } : requestKind === 'removed-effort' ? { reasoning_effort: 'high' } : {}
      const reply = securityTool(request, 'spawn_agent', { name: 'Remote inherited worker', prompt: `REMOTE_CHILD_${marker}: Answer within the original authority.`, ...input }, 'remote-attempt')
      attempted = reply.tools?.[0]?.id === 'remote-attempt'
      return reply
    })
    const createMembers = async (node: OfficeNode, label: string) => {
      const lead = await installTeammate(node.window, 'halo-temp', `${label} coordinator`, 'Coordinate isolated work without sending messages.')
      const member = await installTeammate(node.window, 'halo-temp', `${label} member`, 'Perform only the isolated request.')
      return { lead, member }
    }
    const local = await createMembers(authority, 'Authority')
    const remote = await createMembers(owner, 'Owner')
    const observing = await createMembers(observer, 'Observer')
    const aware = await createAwareTeam(authority.window, { spaceId: 'halo-temp', name: 'Remote model authority', askerAppId: local.lead, askerRole: 'Coordinator', teammateAppId: local.member, teammateRole: 'Verifier', intendedLabel: 'Remote authority work', unrelatedLabel: 'Independent work' })
    const teamId = aware.team.id
    const invite = await authority.api<{ token: string }>('POST', `/api/teams/${teamId}/invite`)
    for (const [node, member] of [[owner, remote.member], [observer, observing.member]] as const) {
      await node.api('POST', `/api/teams/${teamId}/join`, { serverUrl: authority.url, inviteToken: invite.token, bringAppIds: [member] })
    }
    for (const node of [authority, owner, observer]) {
      await expect.poll(async () => (await node.api('GET', `/api/teams/${teamId}/detail`)).members.length, { timeout: 30000 }).toBe(4)
    }
    await owner.api('PATCH', `/api/teams/${teamId}/members/${remote.member}`, { delegatedPolicy: { allowedTools: [], allowCollaboration: true } })
    await owner.api('PUT', '/api/ai-sources/sources/office-private-source', { modelOverrides: { o3: { reasoningEffort: 'high' } } })
    await owner.api('POST', '/api/subagent-models/create', { name: 'Private remote assignment', description: 'REMOTE_PROFILE_PRIVATE_CANARY', target: { kind: 'model', sourceId: 'office-private-source', modelId: 'o3' } })
    const captured = await owner.api<{ id: string }>('POST', '/api/spaces/halo-temp/conversations', { title: 'Private owner reference', reasoningEffort: 'high' })
    await owner.api('POST', '/api/agent/message', { spaceId: 'halo-temp', conversationId: captured.id, message: `OWNER_CAPTURE_${marker}: Read the private model directory.`, thinkingEnabled: true })
    await expect.poll(() => Boolean(reference), { timeout: 60000 }).toBe(true)
    await waitForAcceptanceIdle(owner.window, captured.id)
    const work = await authority.api<{ epochId: string }>('POST', `/api/teams/${teamId}/conversations`, { title: `Restricted ${requestKind}` })
    const epochId = work.epochId
    const sourceKey = buildTeamSessionKey(remote.member, teamId, epochId)
    const scopePath = `/api/teams/collab-for-conversation/${encodeURIComponent(sourceKey)}`
    expect(await owner.api('GET', scopePath)).toBeNull()
    let directoriesBefore: string[] = []
    let memberIdsBefore: string[] = []
    const sending = authority.api('POST', `/api/teams/${teamId}/members/${remote.member}/send`, { epochId, message: `REMOTE_PARENT_${marker}: Check ${requestKind} without borrowing owner choices.`, thinkingEnabled: true })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    const dispatchErrors: unknown[] = []
    try {
      await expect.poll(() => parentHeld, { timeout: 60000 }).toBe(true)
      directoriesBefore = officeWorkspaceDirectories(owner.profile)
      const roster = await owner.api('GET', `/api/teams/${teamId}/epochs/${epochId}/roster`)
      memberIdsBefore = roster.members.map((member: { appId: string }) => member.appId).sort()
      expect(await owner.api('GET', scopePath)).toBeNull()
    } catch (error) { dispatchErrors.push(error) }
    finally { parentGate.release() }
    const dispatched = await sending
    if (dispatched.error) dispatchErrors.push(dispatched.error)
    if (dispatchErrors.length) throw new AggregateError(dispatchErrors, 'Remote office dispatch or gated baseline failed')
    expect(dispatched.value.ok).toBe(true)
    await expect.poll(() => results.length, { timeout: 90000 }).toBeGreaterThan(0)
    const historyPath = `/api/teams/${teamId}/chat-messages?appId=${remote.member}&epochId=${epochId}`
    await expect.poll(async () => (await owner.api<Array<{ content: string }>>('GET', historyPath)).some(message => message.content.includes(`REMOTE_FINISHED_${marker}`)), { timeout: 60000 }).toBe(true)
    expect(attempted).toBe(true)
    expect(parentRequests.length).toBeGreaterThan(0)
    for (const request of parentRequests) {
      expect(request.tools.some(tool => tool.endsWith('list_model_profiles'))).toBe(false)
      expect(request.text).not.toMatch(/REMOTE_PROFILE_PRIVATE_CANARY|Private remote assignment|restoreRef|office-private-credential-canary/)
      expect(request.body.model).toBe('o3')
    }
    if (requestKind === 'inherit') {
      expect(collaboratorReceipt({ id: 'remote-attempt', text: results[0], error: false }).status).toBe('accepted')
      await expect.poll(() => children.length, { timeout: 60000 }).toBeGreaterThan(0)
      for (const child of children) {
        expect(child.body.model).toBe(parentRequests[0].body.model)
        expect(child.body.reasoning_effort).toEqual(parentRequests[0].body.reasoning_effort)
        expect(child.body.reasoning).toEqual(parentRequests[0].body.reasoning)
        expect(child.body.thinking).toEqual(parentRequests[0].body.thinking)
      }
      expect(await owner.api('GET', scopePath)).toBeTruthy()
    } else {
      expect(results.every(refusedSecurityResult)).toBe(true)
      expect(children).toHaveLength(0)
      expect(await owner.api('GET', scopePath)).toBeNull()
      expect(officeWorkspaceDirectories(owner.profile)).toEqual(directoriesBefore)
      const rosterAfter = await owner.api('GET', `/api/teams/${teamId}/epochs/${epochId}/roster`)
      expect(rosterAfter.members.map((member: { appId: string }) => member.appId).sort()).toEqual(memberIdsBefore)
    }
    for (const node of [authority, observer]) {
      const detail = await node.api('GET', `/api/teams/${teamId}/detail`)
      expect(detail.members).toHaveLength(4)
      expect(await node.api('GET', scopePath)).toBeNull()
      const records = [detail, await node.api('GET', `/api/teams/${teamId}/epochs/${epochId}/board`), await node.api('GET', `/api/teams/${teamId}/epochs/${epochId}/roster`), await node.api('GET', historyPath)]
      expect(JSON.stringify(records)).not.toMatch(/office-private-source|office-private-credential-canary|REMOTE_PROFILE_PRIVATE_CANARY|restoreRef|Private remote assignment/)
    }
    expect(ownerModel.errors).toEqual([])
    await info.attach('remote-office-authority-outcome', { body: JSON.stringify({ requestKind, childCount: children.length, results, parentReasoning: parentRequests.map(request => ({ model: request.body.model, effort: request.body.reasoning_effort })) }), contentType: 'application/json' })
  })
}
