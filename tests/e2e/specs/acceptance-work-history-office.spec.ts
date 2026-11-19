/**
 * A teammate's reply stopped mid-sentence reads the same on every computer in
 * the office: the words it had shown and that it was stopped. Three isolated
 * Halo nodes on one machine form a real office link (host, the member's owner,
 * an observer); only their model endpoints are scripted.
 */

import { randomUUID } from 'node:crypto'
import { acceptance, expect } from '../fixtures/acceptance-app'
import { test, type OfficeNode } from '../fixtures/acceptance-subagent-office'
import { installTeammate, createAwareTeam } from '../fixtures/acceptance-team-awareness'
import { createModelGate } from '../fixtures/acceptance-model'

type Row = { role: string; content: string; ending?: string; metadata?: { ending?: string } }

test('a teammate stopped mid-sentence reads the same on every computer in the office',
  acceptance('chat.work-history.office-stopped'), async ({ officeNodes, model }, info) => {
    test.setTimeout(300000)
    const { authority, owner, observer, ownerModel } = officeNodes
    const marker = randomUUID()
    const words = `Half of the rollout plan for ${marker} is`
    const gate = createModelGate()
    let reached = false
    model.respond(() => ({ text: 'AUTHORITY_IDLE' }))
    ownerModel.respond(request => {
      if (!request.text.includes(`OFFICE_STOP_${marker}`)) return { text: 'OBSERVER_IDLE' }
      reached = true
      return { text: words, hold: gate.promise }
    })

    const createMembers = async (node: OfficeNode, label: string) => ({
      lead: await installTeammate(node.window, 'halo-temp', `${label} coordinator`, 'Coordinate isolated work without sending messages.'),
      member: await installTeammate(node.window, 'halo-temp', `${label} member`, 'Answer only the request you are given.'),
    })
    const local = await createMembers(authority, 'Authority')
    const remote = await createMembers(owner, 'Owner')
    const observing = await createMembers(observer, 'Observer')
    const aware = await createAwareTeam(authority.window, { spaceId: 'halo-temp', name: 'Stopped reply office', askerAppId: local.lead, askerRole: 'Coordinator', teammateAppId: local.member, teammateRole: 'Verifier', intendedLabel: 'Rollout plan', unrelatedLabel: 'Independent work' })
    const teamId = aware.team.id
    const invite = await authority.api<{ token: string }>('POST', `/api/teams/${teamId}/invite`)
    for (const [node, member] of [[owner, remote.member], [observer, observing.member]] as const) {
      await node.api('POST', `/api/teams/${teamId}/join`, { serverUrl: authority.url, inviteToken: invite.token, bringAppIds: [member] })
    }
    for (const node of [authority, owner, observer]) {
      await expect.poll(async () => (await node.api('GET', `/api/teams/${teamId}/detail`)).members.length, { timeout: 30000 }).toBe(4)
    }

    const { epochId } = await authority.api<{ epochId: string }>('POST', `/api/teams/${teamId}/conversations`, { title: 'Rollout plan' })
    const sending = authority.api('POST', `/api/teams/${teamId}/members/${remote.member}/send`, { epochId, message: `OFFICE_STOP_${marker}: Draft the rollout plan.`, thinkingEnabled: true })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    try {
      await expect.poll(() => reached, { timeout: 60000 }).toBe(true)
      // The sentence is on its way to the member before the stop lands.
      await new Promise(resolve => setTimeout(resolve, 1500))
      await authority.api('POST', `/api/teams/${teamId}/members/${remote.member}/stop`, { epochId })
    } finally {
      gate.release()
    }
    await sending

    const historyPath = `/api/teams/${teamId}/chat-messages?appId=${remote.member}&epochId=${epochId}`
    const stoppedReply = async (node: OfficeNode) => (await node.api<Row[]>('GET', historyPath))
      .find(row => row.role === 'assistant' && row.content.includes(words))
    // The owner reads its own record; the other nodes read the owner's replica over the office link.
    await expect.poll(async () => (await stoppedReply(owner))?.metadata?.ending, { timeout: 60000 }).toBe('stopped')
    for (const node of [authority, observer]) {
      await expect.poll(async () => (await stoppedReply(node))?.ending, { timeout: 60000 }).toBe('stopped')
      const row = await stoppedReply(node)
      expect(row?.content.trim()).toBe(words)
      expect(row?.metadata).toBeUndefined()
    }
    expect(ownerModel.errors).toEqual([])
    await info.attach('office-stopped-rows', {
      body: JSON.stringify({ owner: await stoppedReply(owner), authority: await stoppedReply(authority), observer: await stoppedReply(observer) }),
      contentType: 'application/json',
    })
  })
