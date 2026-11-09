import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { CollabSummary, EpochRoster, TeamParticipant } from '../../../src/shared/apps/team-types'
import { buildTeamSessionKey } from '../../../src/shared/apps/im-keys'
import type { Thought, TranscriptMessage } from '../../../src/shared/types/transcript'
import { test, expect, hasApiKey } from '../fixtures/electron'
import { commandWorkspace, openCommandWorkspace } from '../fixtures/acceptance-terminal'
import { sendMessage } from '../fixtures/helpers'

test.use({ sdkEngine: 'halo' })
test.setTimeout(240000)

interface LiveProbe { sourceId: string | null; errors: unknown[]; dispose(): void }
interface LiveWindow { halo: HaloAPI; liveCollaboration?: LiveProbe }

async function sourceMessages(page: Page, spaceId: string, conversationId: string): Promise<TranscriptMessage[]> {
  return page.evaluate(async input => {
    const response = await (globalThis as unknown as LiveWindow).halo.getConversation(input.spaceId, input.conversationId)
    if (!response.success || !response.data) throw new Error('The source transcript is unavailable.')
    return (response.data as { messages: TranscriptMessage[] }).messages
  }, { spaceId, conversationId })
}

function readObserved(messages: TranscriptMessage[], file: string, nonce: string): boolean {
  return messages.some(message => message.thoughts?.some(thought => thought.type === 'tool_use'
    && thought.toolName?.split('__').at(-1) === 'Read'
    && JSON.stringify(thought.toolInput ?? {}).includes(file)
    && !thought.toolResult?.isError && `${thought.toolResult?.output ?? ''}\n${thought.toolOutput ?? ''}`.includes(nonce))
    || message.toolCalls?.some(tool => tool.name.split('__').at(-1) === 'Read'
      && JSON.stringify(tool.input).includes(file) && tool.status === 'success' && tool.output?.includes(nonce)))
}

test('a live model delegates separate file reads and combines both collaborator reports in the source', {
  annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'teams.collaboration.live-delegation', evidence: 'live-model', mode: 'live', variant: {} }) },
}, async ({ window, electronApp }, testInfo) => {
  testInfo.skip(!hasApiKey(), 'Live acceptance requires a configured bounded model broker.')
  expect(process.env.HALO_ACCEPTANCE_MODE, 'This case must use the existing budgeted live broker.').toBe('brokered-live')
  const environment = await electronApp.evaluate(({ app }) => ({ dataDir: process.env.HALO_DATA_DIR,
    packaged: app.isPackaged, platform: process.platform, electron: process.versions.electron }))
  if (!environment.dataDir || !dirname(environment.dataDir).includes('halo-e2e-test-')) throw new Error('An isolated application profile is required.')
  const availability = await window.evaluate(() => (globalThis as unknown as LiveWindow).halo.getEngineAvailability())
  expect(availability).toMatchObject({ success: true, data: { activeEngine: 'halo', degradedFrom: null } })
  await testInfo.attach('live-collaboration-engine', { body: JSON.stringify({ availability, ...environment }), contentType: 'application/json' })

  const space = await commandWorkspace(window, dirname(environment.dataDir), 'Live delegation')
  const inputs = [{ file: 'left-evidence.txt', nonce: `left-${randomUUID()}` }, { file: 'right-evidence.txt', nonce: `right-${randomUUID()}` }]
  for (const input of inputs) writeFileSync(join(space.workingDir, input.file), `${input.nonce}\n`)
  await openCommandWorkspace(window, space)
  await window.getByRole('button', { name: 'Add files, context and capabilities', exact: true }).click()
  const capability = window.getByRole('menuitemcheckbox', { name: /Team Collaboration/ })
  await expect(capability).toHaveCount(0)
  await window.keyboard.press('Escape')
  await window.evaluate(spaceId => {
    const state = globalThis as unknown as LiveWindow
    const probe: LiveProbe = { sourceId: null, errors: [], dispose: () => {} }
    const start = state.halo.onAgentTurnStart(value => {
      const event = value as { spaceId?: string; conversationId?: string }
      if (event.spaceId === spaceId && event.conversationId && !probe.sourceId) probe.sourceId = event.conversationId
    })
    const errors = state.halo.onAgentError(value => { probe.errors.push(value) })
    probe.dispose = () => { start(); errors(); delete state.liveCollaboration }
    state.liveCollaboration = probe
  }, space.id)

  let sourceId: string | null = null
  let scope: CollabSummary | undefined
  const memberEvidence: Array<{ appId: string; conversationId: string; messages: TranscriptMessage[] }> = []
  let source: TranscriptMessage[] = []
  let thoughts: Thought[] = []
  try {
    await sendMessage(window, `Use two separate collaborators for this read-only task. Create both with spawn_agent yourself. Give one collaborator ${inputs[0].file} and the other ${inputs[1].file} in the current workspace. Each collaborator must use Read on its own assigned file and report the exact value back to you. Do not read either file yourself and do not modify any files. After both reports arrive, reply here with both values together. The values are only in the files; do not guess them. You may finish an interim reply while collaborators work, but deliver the combined answer here when they report.`)
    await expect.poll(() => window.evaluate(() => (globalThis as unknown as LiveWindow).liveCollaboration?.sourceId), { timeout: 30000 }).toBeTruthy()
    sourceId = await window.evaluate(() => (globalThis as unknown as LiveWindow).liveCollaboration!.sourceId)
    if (!sourceId) throw new Error('The source conversation did not start.')
    await expect.poll(async () => {
      source = await sourceMessages(window, space.id, sourceId!)
      return source.some(message => message.role === 'assistant' && inputs.every(input => message.content.includes(input.nonce)))
    }, { timeout: 180000, intervals: [500, 1000, 2000], message: 'Both independently read values must arrive in one persisted source answer.' }).toBe(true)
    await expect.poll(async () => {
      const result = await window.evaluate(id => (globalThis as unknown as LiveWindow).halo.getSessionState(id), sourceId!)
      return result.success && (result.data as { isActive: boolean }).isActive === false
    }, { timeout: 30000 }).toBe(true)
    await expect(window.locator('.message-assistant').filter({ hasText: inputs[0].nonce }).filter({ hasText: inputs[1].nonce }).last()).toBeVisible()

    const association = await window.evaluate(id => (globalThis as unknown as LiveWindow).halo.teamCollabForConversation(id), sourceId)
    expect(association.success).toBe(true)
    scope = association.data as CollabSummary
    expect(scope?.teamId).toBeTruthy()
    const rosterResponse = await window.evaluate(input => (globalThis as unknown as LiveWindow).halo.teamEpochRoster(input), { teamId: scope.teamId, epochId: scope.epochId })
    expect(rosterResponse.success).toBe(true)
    const roster = rosterResponse.data as EpochRoster
    const members = roster.members.filter(member => (member as TeamParticipant).isTemporary) as TeamParticipant[]
    expect(members.length).toBeGreaterThanOrEqual(2)
    for (const member of members) {
      expect(member).toMatchObject({ teamId: scope.teamId, epochId: scope.epochId, isTemporary: true })
      const result = await window.evaluate(input => (globalThis as unknown as LiveWindow).halo.teamChatMessages(input), {
        appId: member.appId, spaceId: space.id, teamId: scope.teamId, epochId: scope.epochId,
      })
      expect(result.success).toBe(true)
      memberEvidence.push({ appId: member.appId, conversationId: buildTeamSessionKey(member.appId, scope.teamId, scope.epochId), messages: result.data as TranscriptMessage[] })
    }
    const left = memberEvidence.find(member => readObserved(member.messages, inputs[0].file, inputs[0].nonce))
    const right = memberEvidence.find(member => readObserved(member.messages, inputs[1].file, inputs[1].nonce))
    expect(left, 'A collaborator must have an actual successful Read result for the first value.').toBeTruthy()
    expect(right, 'A different collaborator must have an actual successful Read result for the second value.').toBeTruthy()
    expect(left!.appId).not.toBe(right!.appId)
    expect(left!.conversationId).not.toBe(right!.conversationId)
    for (const member of [left!, right!]) {
      const wrongScope = await window.evaluate(input => (globalThis as unknown as LiveWindow).halo.teamChatMessages(input), {
        appId: member.appId, spaceId: space.id, teamId: scope.teamId, epochId: randomUUID(),
      })
      expect(wrongScope).toMatchObject({ success: true, data: [] })
    }
    for (const message of source.filter(message => message.role === 'assistant')) {
      const response = await window.evaluate(input => (globalThis as unknown as LiveWindow).halo.getMessageThoughts(input.spaceId, input.conversationId, input.messageId), {
        spaceId: space.id, conversationId: sourceId, messageId: message.id,
      })
      expect(response.success).toBe(true)
      thoughts.push(...response.data as Thought[])
    }
    expect(thoughts.filter(thought => thought.type === 'tool_use' && thought.toolName?.split('__').at(-1) === 'spawn_agent').length).toBeGreaterThanOrEqual(2)
    for (const input of inputs) expect(readFileSync(join(space.workingDir, input.file), 'utf8')).toBe(`${input.nonce}\n`)
    expect(await window.evaluate(() => (globalThis as unknown as LiveWindow).liveCollaboration!.errors)).toEqual([])
  } finally {
    await testInfo.attach('live-delegation-evidence', { body: JSON.stringify({ inputs, sourceId, scope, source, thoughts, members: memberEvidence }, null, 2), contentType: 'application/json' })
    await window.evaluate(() => (globalThis as unknown as LiveWindow).liveCollaboration?.dispose())
  }
})
