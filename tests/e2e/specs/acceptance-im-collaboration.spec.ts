import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import { buildImSessionKey } from '../../../src/shared/apps/im-keys'
import { test, expect, OWNER_ID, GUEST_ID, GROUP_ID, imTranscript, waitForImIdle, waitForGuestChannel } from '../fixtures/acceptance-guest'
import { acceptance } from '../fixtures/acceptance-app'
import { createImCollaborationScript, question, later, started, acknowledged, assignment, raw, reviewed, probe, probeReply } from '../fixtures/acceptance-im-collaboration'
import { modelTool, latestUserInput, type ModelRequest } from '../fixtures/acceptance-model'

const authorityTools = ['Bash', 'team_read_member'] as const
const hasTool = (request: ModelRequest, name: string) => request.tools.some(tool => tool === name || tool.endsWith(`__${name}`))
const toolAuthority = (request: ModelRequest) => Object.fromEntries(authorityTools.map(name => [name, hasTool(request, name)]))
const refusal = /(?:\b(?:permissions?|access) denied\b|\bpermission to (?:use|call) [^\n]{1,120}(?:was|is|has been) denied\b|\bnot (?:allowed|permitted|granted|authorized)\b|Only files inside this workspace can be used here|\bunknown (?:tool|function)\b|\b(?:tool|function)[^\n]{0,180}(?:not found|not registered|unavailable))/i

for (const authority of ['owner', 'guest'] as const) {
  test(`an IM ${authority} receives a reviewed result under its original authority after another sender speaks`, acceptance('teams.collaboration.im-source', { authority }), async ({ guestApp, wecom, model, window }, testInfo) => {
    test.setTimeout(180000)
    if (authority === 'guest') {
      const updated = await window.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.imChannelsUpdateInstance(id, { guestPolicy: { allowCollaboration: true, allowedTools: [] } }), guestApp.instanceId)
      expect(updated.success).toBe(true)
      await waitForGuestChannel(window, guestApp, wecom)
    }
    const forbiddenWrite = join(guestApp.workDir, 'collaboration-guest-must-not-write.txt')
    const outsideDirectory = join(guestApp.profile, 'outside-collaboration-workspace')
    const outsideFile = join(outsideDirectory, 'private-control.txt')
    const outsideMarker = `Private owner evidence ${randomUUID()}`
    const probeResults: ModelRequest['toolResults'] = []
    if (authority === 'guest') {
      mkdirSync(outsideDirectory, { recursive: true })
      writeFileSync(outsideFile, outsideMarker)
      expect(existsSync(forbiddenWrite)).toBe(false)
    }
    const flow = createImCollaborationScript({
      deferredProbe: { name: 'list_automation_apps', id: 'im-authority' },
      onReview: authority === 'guest' ? request => {
        for (const attempt of [
          { id: 'callback-forbidden-write', tool: 'Write', input: { file_path: forbiddenWrite, content: 'This guest side effect must be refused.' } },
          { id: 'callback-outside-read', tool: 'Read', input: { file_path: outsideFile } },
        ]) {
          const result = request.toolResults.find(result => result.id === attempt.id)
          if (!result) return { tools: [modelTool(request, attempt.tool, attempt.input, attempt.id)] }
          if (!probeResults.some(value => value.id === result.id)) probeResults.push(result)
        }
        return { text: reviewed }
      } : undefined,
    })
    model.respond(flow.reply)
    try {
      const senderId = authority === 'owner' ? OWNER_ID : GUEST_ID
      const sent = await wecom.sendText({ senderId, senderName: authority, chatId: GROUP_ID, chatType: 'group', text: question })
      await wecom.waitForReply({ requestId: sent.requestId, contains: started })
      await expect.poll(() => flow.memberStarted).toBe(true)
      await waitForImIdle(window, guestApp, GROUP_ID, 'group')
      const next = await wecom.sendText({ senderId: authority === 'owner' ? GUEST_ID : OWNER_ID, senderName: 'Later sender', chatId: GROUP_ID, chatType: 'group', text: later })
      await wecom.waitForReply({ requestId: next.requestId, contains: acknowledged })
      await waitForImIdle(window, guestApp, GROUP_ID, 'group')
      flow.release()
      await wecom.waitForReply({ chatId: GROUP_ID, contains: reviewed, timeoutMs: 90000 })
      await waitForImIdle(window, guestApp, GROUP_ID, 'group')
      expect(flow.initialRequests.length).toBeGreaterThan(0)
      expect(flow.laterRequests).toHaveLength(1)
      expect(flow.callbacks.length).toBeGreaterThan(0)
      const initial = flow.initialRequests[0], subsequent = flow.laterRequests[0]
      const owner = authority === 'owner' ? initial : subsequent
      const guest = authority === 'guest' ? initial : subsequent
      if (authority === 'owner') {
        expect(flow.probe?.error).toBeUndefined()
        expect(flow.probe?.results.some(result => !result.error), 'The owner can call a discovered app tool').toBe(true)
      } else {
        expect(
          flow.probe?.error !== undefined
          || ((flow.probe?.results.length ?? 0) > 0 && flow.probe!.results.every(result => result.error)),
          'A guest cannot discover or call the app service',
        ).toBe(true)
      }
      for (const name of authorityTools) {
        expect(hasTool(owner, name), `Owner receives ${name}`).toBe(true)
        expect(hasTool(guest, name), `Guest is not lent ${name}`).toBe(false)
      }
      expect(hasTool(initial, 'spawn_agent')).toBe(true)
      for (const callback of flow.callbacks) {
        expect(toolAuthority(callback)).toEqual(toolAuthority(initial))
        expect(toolAuthority(callback)).not.toEqual(toolAuthority(subsequent))
        expect(latestUserInput(callback)).toContain(senderId)
        expect(latestUserInput(callback)).not.toContain(authority === 'owner' ? GUEST_ID : OWNER_ID)
      }
      const reviewedReplies = wecom.replies.filter(reply => reply.finished && reply.text.includes(reviewed))
      expect(reviewedReplies).toHaveLength(1)
      expect(reviewedReplies[0].chatId).toBe(GROUP_ID)
      if (authority === 'guest') {
        expect(probeResults.map(result => result.id)).toEqual(['callback-forbidden-write', 'callback-outside-read'])
        for (const result of probeResults) {
          expect(result.text).toMatch(refusal)
          expect(result.text).not.toContain(outsideMarker)
          expect(result.text).not.toMatch(/FOREIGN KEY|SQLITE_|constraint failed/i)
        }
        expect(existsSync(forbiddenWrite)).toBe(false)
        expect(readFileSync(outsideFile, 'utf8')).toBe(outsideMarker)
        expect(flow.callbacks.some(request => request.text.includes(outsideMarker))).toBe(false)
        expect(wecom.replies.some(reply => reply.text.includes(outsideMarker))).toBe(false)
      }
      await testInfo.attach('collaboration-authority-evidence', { contentType: 'application/json', body: JSON.stringify({
        initial: { sequence: initial.sequence, tools: toolAuthority(initial) },
        later: { sequence: subsequent.sequence, tools: toolAuthority(subsequent) },
        callbacks: flow.callbacks.map(request => ({ sequence: request.sequence, tools: toolAuthority(request), originalCaller: latestUserInput(request).includes(senderId) })),
        probes: probeResults, receiver: reviewedReplies[0].chatId,
      }, null, 2) })
      expect(wecom.replies.some(reply => reply.text.includes(raw)), 'Member output must never be forwarded without source review').toBe(false)
      const history = await imTranscript(window, guestApp, GROUP_ID, 'group')
      expect(history.messages.some(message => message.content.includes(raw))).toBe(true)
      expect(history.messages.some(message => message.role === 'assistant' && message.content.includes(reviewed))).toBe(true)
      const unrelated = await window.evaluate(conversationId => (window as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(conversationId), buildImSessionKey(guestApp.appId, 'wecom-bot', 'direct', OWNER_ID))
      expect(unrelated.data ?? null).toBeNull()
      expect(flow.errors).toEqual([])
    } finally { flow.release() }
  })
}

test('an IM guest without collaboration permission cannot create a collaborator', acceptance('teams.collaboration.im-guest-denied'), async ({ guestApp, wecom, model, window }) => {
  const exposed: string[] = []
  model.respond(request => { exposed.push(...request.tools); return { text: 'Collaboration is not granted in this guest chat.' } })
  const sent = await wecom.sendText({ senderId: GUEST_ID, chatId: GROUP_ID, chatType: 'group', text: question })
  await wecom.waitForReply({ requestId: sent.requestId, contains: 'Collaboration is not granted' })
  await waitForImIdle(window, guestApp, GROUP_ID, 'group')
  expect(exposed.some(name => name === 'spawn_agent' || name.endsWith('__spawn_agent'))).toBe(false)
  const summary = await window.evaluate(conversationId => (window as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(conversationId), buildImSessionKey(guestApp.appId, 'wecom-bot', 'group', GROUP_ID))
  expect(summary.data ?? null).toBeNull()
})

for (const invalidation of ['stop', 'clear', 'authority'] as const) {
  test(`an IM collaboration result cannot wake the source after ${invalidation}`, acceptance('teams.collaboration.im-source-cancel', { invalidation }), async ({ guestApp, wecom, model, window }) => {
    test.setTimeout(180000)
    const flow = createImCollaborationScript()
    model.respond(flow.reply)
    try {
      const sent = await wecom.sendText({ senderId: OWNER_ID, chatId: GROUP_ID, chatType: 'group', text: question })
      await wecom.waitForReply({ requestId: sent.requestId, contains: started })
      await expect.poll(() => flow.memberStarted).toBe(true)
      await waitForImIdle(window, guestApp, GROUP_ID, 'group')
      if (invalidation === 'authority') {
        for (const owners of [[GUEST_ID], [OWNER_ID]]) {
          const response = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.imChannelsUpdateInstance(input.id, { owners: input.owners }), { id: guestApp.instanceId, owners })
          expect(response.success).toBe(true)
        }
        await waitForGuestChannel(window, guestApp, wecom)
      } else {
        const command = await wecom.sendText({ senderId: OWNER_ID, chatId: GROUP_ID, chatType: 'group', text: `@Halo /${invalidation}` })
        await wecom.waitForReply({ requestId: command.requestId, contains: invalidation === 'stop' ? 'Generation stopped.' : 'Context cleared.' })
      }
      flow.release()
      await expect.poll(() => model.exchanges.filter(exchange => exchange.request.text.includes(assignment)).every(exchange => exchange.completed || exchange.cancelled), { timeout: 30000 }).toBe(true)
      const fresh = await wecom.sendText({ senderId: OWNER_ID, chatId: GROUP_ID, chatType: 'group', text: probe })
      await wecom.waitForReply({ requestId: fresh.requestId, contains: probeReply })
      await waitForImIdle(window, guestApp, GROUP_ID, 'group')
      expect(flow.callbacks).toEqual([])
      expect(wecom.replies.some(reply => reply.text.includes(reviewed) || reply.text.includes(raw))).toBe(false)
      const history = await imTranscript(window, guestApp, GROUP_ID, 'group')
      expect(history.messages.some(message => message.content.includes(raw))).toBe(false)
      expect(flow.errors).toEqual([])
    } finally { flow.release() }
  })
}
