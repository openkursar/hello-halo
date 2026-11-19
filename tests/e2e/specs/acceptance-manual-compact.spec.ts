import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import { acceptance, expect, readAcceptanceConversation, sendAcceptanceMessage, test, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { openManagedConversation } from '../fixtures/acceptance-management'
import type { ModelRequest } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'

const modelId = 'claude-sonnet-4-5-20250929'
const latestConstraint = 'Use only the verified value amber-218.'
const handover = `The verified value is amber-218. ${latestConstraint}`
const initialReply = 'The original evidence is recorded.'
const continuedReply = 'The retained verified value is amber-218.'

test.use({ sdkEngine: 'halo', aiSource: async ({ model }, use) => {
  await use({ provider: 'anthropic', model: modelId, apiUrl: model.url, apiKey: 'local-scripted-endpoint' })
} })

function unsignedReasoning(request: ModelRequest) {
  for (const [messageIndex, message] of request.messages.entries()) {
    if (!Array.isArray(message.content)) continue
    const blockIndex = message.content.findIndex(block => block.type === 'thinking' && !block.signature)
    if (blockIndex >= 0) return `messages.${messageIndex}.content.${blockIndex}.thinking.signature: Field required`
  }
}

test('manual compaction after reopening keeps evidence when the current model rejects older reasoning', acceptance('chat.messages.manual-compact-mixed-history'), async ({ acceptanceApp, model, window }, info) => {
  test.setTimeout(120000)
  const summaryAttempts: ModelRequest[] = []
  const unexpected: number[] = []
  let continued: ModelRequest | undefined
  const followUp = 'What verified value did we agree to use?'
  model.respond(request => {
    const rejection = unsignedReasoning(request)
    if (request.lastUserText.includes('Prepare a compact handover for another assistant continuing the same task.') || request.lastUserText.includes('<conversation_to_summarize')) {
      summaryAttempts.push(request)
      if (rejection) return { failure: { status: 400, type: 'invalid_request_error', message: rejection } }
      return { text: handover }
    }
    if (request.lastUserText.includes(followUp)) {
      continued = request
      if (rejection) return { failure: { status: 400, type: 'invalid_request_error', message: rejection } }
      return { text: continuedReply }
    }
    if (summaryAttempts.length || request.lastUserText.includes('/compact')) unexpected.push(request.sequence)
    return { text: initialReply }
  })

  await navigateToChat(window)
  const first = await sendAcceptanceMessage(window, `Record the evidence. ${'Observed evidence remains read-only. '.repeat(800)}`)
  for (let index = 0; index < 5; index++) {
    await waitForAcceptanceIdle(window, first.conversationId)
    await sendAcceptanceMessage(window, `Evidence ${index}: ${'Retain the verified project facts. '.repeat(550)}`, { expectedTarget: first })
  }
  await waitForAcceptanceIdle(window, first.conversationId)
  await sendAcceptanceMessage(window, latestConstraint, { expectedTarget: first })
  await waitForAcceptanceIdle(window, first.conversationId)
  const saved = await readAcceptanceConversation(window, first.spaceId, first.conversationId)
  expect(saved.messages.filter(message => message.content === initialReply)).toHaveLength(7)
  const sessionId = await window.evaluate(async ({ spaceId, conversationId }) => {
    const conversation = await (globalThis as unknown as { halo: HaloAPI }).halo.getConversation(spaceId, conversationId)
    return (conversation.data as { sessionId?: string } | undefined)?.sessionId
  }, first)
  expect(sessionId).toBeTruthy()

  let journal = ''
  let original = ''
  const reopened = await acceptanceApp.restart(async profile => {
    const projects = join(profile, 'sdk-state', 'projects')
    const paths = (await readdir(projects, { recursive: true })).filter(path => path.endsWith(`/${sessionId}.jsonl`) || path.endsWith(`\\${sessionId}.jsonl`))
    expect(paths).toHaveLength(1)
    journal = join(projects, paths[0])
    const records = (await readFile(journal, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
    const prior = records.findLast(record => record.type === 'assistant' && record.message.content.some((block: { text?: string }) => block.text === initialReply))
    expect(prior).toBeTruthy()
    // Seed the unsigned block that a different reasoning provider can leave in an older response.
    prior.message.content.unshift({ type: 'thinking', thinking: 'Earlier provider reasoning summary.' })
    prior.message.model = 'earlier-reasoning-model'
    const metadata = records.find(record => record.type === 'assistant_metadata' && record.responseUuid === prior.responseUuid)
    if (metadata) metadata.message.model = prior.message.model
    original = `${records.map(record => JSON.stringify(record)).join('\n')}\n`
    await writeFile(journal, original)
  })
  await openManagedConversation(reopened, saved.title, first.spaceId)
  const workRequests = model.exchanges.length
  await sendAcceptanceMessage(reopened, '/compact retain the verified facts', { expectedTarget: first })
  await waitForAcceptanceIdle(reopened, first.conversationId)
  expect(summaryAttempts).toHaveLength(2)
  expect(model.exchanges.slice(workRequests)).toHaveLength(2)
  expect(unsignedReasoning(summaryAttempts[0])).toContain('thinking.signature: Field required')
  expect(unsignedReasoning(summaryAttempts[1])).toBeUndefined()
  for (const request of summaryAttempts) {
    expect(request.protocol).toBe('anthropic')
    expect(request.body.model).toBe(modelId)
    expect(request.lastUserText).toContain('retain the verified facts')
    expect(request.text).toContain(latestConstraint)
    expect(request.text).toContain(initialReply)
    expect(request.text).not.toContain('/compact')
  }
  const checkpointed = await readFile(journal, 'utf8')
  expect(checkpointed.startsWith(original)).toBe(true)
  const records = checkpointed.slice(original.length).trim().split('\n').map(line => JSON.parse(line))
  expect(records.filter(record => record.type === 'compact_checkpoint')).toEqual([expect.objectContaining({ summary: handover })])
  const after = await readAcceptanceConversation(reopened, first.spaceId, first.conversationId)
  expect(after.messages.some(message => message.error)).toBe(false)
  expect(after.messages.filter(message => message.content === initialReply)).toHaveLength(7)

  const continuedWindow = await acceptanceApp.restart()
  await openManagedConversation(continuedWindow, saved.title, first.spaceId)
  await sendAcceptanceMessage(continuedWindow, followUp, { expectedTarget: first })
  await expect(continuedWindow.locator('.message-assistant [data-message-content]').last()).toHaveText(continuedReply)
  await waitForAcceptanceIdle(continuedWindow, first.conversationId)
  expect(continued?.text).toContain(handover)
  expect(continued?.text).toContain(latestConstraint)
  expect(continued && unsignedReasoning(continued)).toBeUndefined()
  expect(unexpected).toEqual([])
  await info.attach('manual-compaction-recovery', { body: JSON.stringify({ summaryAttempts: summaryAttempts.length, originalPreserved: true, committedCheckpoints: 1, continuedAfterRestart: true }), contentType: 'application/json' })
})
