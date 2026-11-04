import { randomUUID } from 'node:crypto'
import {
  test as appTest, expect, acceptance, readAcceptanceConversation, readAcceptanceErrors,
  sendAcceptanceMessage, waitForAcceptanceIdle,
} from '../fixtures/acceptance-app'
import { startKiroUpstream, type KiroEvent, type KiroUpstream } from '../fixtures/acceptance-kiro-upstream'
import { navigateToChat } from '../fixtures/helpers'

const KIRO_MODEL = 'claude-sonnet-4.5'
// Longer than the SDK's first retry backoff: guards that this deterministic failure is never retried.
const RETRY_WINDOW_MS = 8000

const test = appTest.extend<{ kiro: KiroUpstream }>({
  kiro: async ({}, use, info) => {
    const kiro = await startKiroUpstream()
    try {
      await use(kiro)
      expect(kiro.errors, 'Every Kiro request must match the declared script').toEqual([])
    } finally {
      await info.attach('kiro-upstream-requests', { body: JSON.stringify({ requests: kiro.requests.map(({ sequence, path, currentText, receivedAt, body }) => ({ sequence, path, currentText, receivedAt, modelId: body.conversationState?.currentMessage?.userInputMessage?.modelId })), errors: kiro.errors }, null, 2), contentType: 'application/json' })
      await kiro.close()
    }
  },
  aiSource: async ({ kiro }, use) => {
    await use({ provider: 'openai', apiType: 'kiro', apiKey: 'local-scripted-kiro', apiUrl: kiro.url, model: KIRO_MODEL })
  },
})

test.setTimeout(150000)

async function failsOnceThenRecovers(
  { kiro, window }: { kiro: KiroUpstream; window: import('@playwright/test').Page },
  failing: KiroEvent[],
  reason: string,
  reasoning: string,
) {
  const question = `Kiro acceptance question ${randomUUID()}`
  const followUp = `Kiro follow-up ${randomUUID()}`
  const answer = `Kiro answer ${randomUUID()}`
  kiro.respond(request => {
    // The follow-up turn may carry the failed question merged into it.
    if (request.currentText.includes(followUp)) return [{ event: 'assistantResponseEvent', payload: { content: answer } }]
    if (request.currentText.includes(question)) return failing
    throw new Error(`Unexpected Kiro request ${request.sequence}: ${request.currentText.slice(0, 200)}`)
  })
  await navigateToChat(window)
  const sentAt = Date.now()
  const failed = await sendAcceptanceMessage(window, question)
  await expect(window.getByText(reason, { exact: false }).first()).toBeVisible({ timeout: 20000 })
  const shownAfterMs = Date.now() - sentAt
  const errors = await readAcceptanceErrors(window)
  expect(errors.length).toBeGreaterThan(0)
  for (const error of errors) expect(error).toMatchObject({ type: 'error', conversationId: failed.conversationId, error: expect.stringContaining(reason) })
  await waitForAcceptanceIdle(window, failed.conversationId, { expectedErrors: errors })

  await window.waitForTimeout(RETRY_WINDOW_MS)
  expect(kiro.requests.filter(request => request.currentText.includes(question))).toHaveLength(1)
  expect(kiro.requests).toHaveLength(1)
  expect(kiro.requests[0].body.conversationState?.currentMessage?.userInputMessage?.modelId).toBeTruthy()

  const stored = await readAcceptanceConversation(window, failed.spaceId, failed.conversationId)
  expect(stored.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([question])
  expect(stored.messages.some(message => message.error?.includes(reason))).toBe(true)
  expect(stored.messages.some(message => message.role === 'assistant' && message.content.trim() && !message.error)).toBe(false)
  expect(stored.messages.some(message => message.content.includes(reasoning))).toBe(false)

  const next = await sendAcceptanceMessage(window, followUp)
  expect(next.conversationId).toBe(failed.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText(answer)
  await waitForAcceptanceIdle(window, next.conversationId, { expectedErrors: errors })
  expect(kiro.requests).toHaveLength(2)
  const after = await readAcceptanceConversation(window, next.spaceId, next.conversationId)
  expect(after.messages.filter(message => message.role === 'assistant' && message.content === answer && !message.error)).toHaveLength(1)
  return { shownAfterMs, requests: kiro.requests.length }
}

test('a Kiro refusal shows its explanation once, without a retried request', acceptance('chat.provider-replies.kiro-refusal'), async ({ kiro, window }, info) => {
  const explanation = `The selected model cannot continue this conversation ${randomUUID()}`
  const reasoning = `Refusal reasoning ${randomUUID()}`
  const result = await failsOnceThenRecovers({ kiro, window }, [
    { event: 'initial-response', payload: { conversationId: randomUUID() } },
    { event: 'reasoningContentEvent', payload: { text: reasoning } },
    { event: 'reasoningContentEvent', payload: { signature: 'sig' } },
    { event: 'metadataEvent', payload: { stopReason: 'CONTENT_FILTERED', stopDetails: { refusal: { category: 'CYBER', explanation } } } },
    { event: 'contextUsageEvent', payload: { contextUsagePercentage: 7.4 } },
  ], explanation, reasoning)
  await info.attach('kiro-refusal', { body: JSON.stringify(result), contentType: 'application/json' })
})

test('a Kiro reply with reasoning only reports that no content came back, without a retried request', acceptance('chat.provider-replies.kiro-reasoning-only'), async ({ kiro, window }, info) => {
  const reasoning = `Reasoning without an answer ${randomUUID()}`
  const result = await failsOnceThenRecovers({ kiro, window }, [
    { event: 'reasoningContentEvent', payload: { text: reasoning } },
    { event: 'reasoningContentEvent', payload: { signature: 'sig' } },
  ], 'returned no content', reasoning)
  await expect(window.getByText('reasoning only, no answer', { exact: false }).first()).toBeVisible()
  await info.attach('kiro-reasoning-only', { body: JSON.stringify(result), contentType: 'application/json' })
})
