import { randomUUID } from 'node:crypto'
import {
  test, expect, acceptance, readAcceptanceConversation,
  sendAcceptanceMessage, waitForAcceptanceIdle,
} from '../fixtures/acceptance-app'
import { contentText, type ModelRequest } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'

test.setTimeout(150000)

// The text parts of the newest user message exactly as the engine sent them to the model.
function lastUserParts(request: ModelRequest): string[] {
  const user = request.messages.filter(message => message.role === 'user' && contentText(message.content)).at(-1)
  if (!user) return []
  if (typeof user.content === 'string') return [user.content]
  return (user.content as Array<Record<string, unknown>>).filter(part => part?.type === 'text').map(part => String(part.text ?? ''))
}

// Follow-ups reach the engine verbatim; a new conversation's first turn carries the
// space memory ahead of the text, so the opener is matched by containment.
async function openConversation(window: Parameters<typeof navigateToChat>[0], opener: string) {
  await navigateToChat(window)
  const first = await sendAcceptanceMessage(window, opener)
  await waitForAcceptanceIdle(window, first.conversationId)
  return first
}

test('slash-leading text that is not a command reaches the model verbatim and gets its reply', acceptance('chat.messages.slash-text'), async ({ model, window }, info) => {
  const opener = `Open this isolated conversation ${randomUUID()}`
  const inputs = ['/uer/dsds', '/tmp/example.txt', '/Users/me/app.log 看一下这个日志']
  const replies = new Map<string, string>([[opener, `Ready ${randomUUID()}`], ...inputs.map(input => [input, `Reply to ${input} ${randomUUID()}`] as [string, string])])
  model.respond(request => {
    const parts = lastUserParts(request)
    const input = inputs.find(text => parts.includes(text)) ?? (parts.some(part => part.includes(opener)) ? opener : undefined)
    if (!input) throw new Error(`Unexpected slash-text request ${request.sequence}: ${JSON.stringify(parts)}`)
    return { text: replies.get(input)! }
  })

  const first = await openConversation(window, opener)
  const observations: Array<{ input: string; requests: number; verbatim: boolean }> = []
  for (const input of inputs) {
    const before = model.exchanges.length
    const turn = await sendAcceptanceMessage(window, input)
    expect(turn.conversationId).toBe(first.conversationId)
    await expect(window.locator('.message-assistant').last()).toContainText(replies.get(input)!)
    await waitForAcceptanceIdle(window, turn.conversationId)
    const exchanges = model.exchanges.slice(before)
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0].completed).toBe(true)
    expect(lastUserParts(exchanges[0].request)).toContain(input)
    observations.push({ input, requests: exchanges.length, verbatim: lastUserParts(exchanges[0].request).includes(input) })
  }

  await expect(window.getByText('Unknown command', { exact: false })).toHaveCount(0)
  await expect(window.getByText('Something went wrong', { exact: true })).toHaveCount(0)
  const stored = await readAcceptanceConversation(window, first.spaceId, first.conversationId)
  expect(stored.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([opener, ...inputs])
  for (const input of inputs) {
    expect(stored.messages.filter(message => message.role === 'assistant' && message.content === replies.get(input) && !message.error)).toHaveLength(1)
  }
  expect(stored.messages.some(message => message.error || message.content.includes('Unknown command'))).toBe(false)
  await info.attach('slash-text', { body: JSON.stringify({ conversationId: first.conversationId, observations }), contentType: 'application/json' })
})

test('an available command typed in the composer runs as a command instead of reaching the model', acceptance('chat.messages.slash-command'), async ({ model, window }, info) => {
  const opener = `Open this isolated conversation ${randomUUID()}`
  const ready = `Ready ${randomUUID()}`
  model.respond(request => {
    if (lastUserParts(request).some(part => part.includes(opener))) return { text: ready }
    return { text: `The model unexpectedly received ${JSON.stringify(lastUserParts(request))}` }
  })

  const first = await openConversation(window, opener)
  await expect(window.locator('.message-assistant').last()).toContainText(ready)
  const before = model.exchanges.length

  const composer = window.locator('textarea').first()
  await composer.fill('/help')
  await expect(window.getByRole('button', { name: /^\/help\b/ })).toBeVisible()
  const turn = await sendAcceptanceMessage(window, '/help')
  expect(turn.conversationId).toBe(first.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText('Available commands')
  await waitForAcceptanceIdle(window, turn.conversationId)

  expect(model.exchanges.slice(before)).toHaveLength(0)
  await expect(window.getByText('Something went wrong', { exact: true })).toHaveCount(0)
  const stored = await readAcceptanceConversation(window, first.spaceId, first.conversationId)
  const reply = stored.messages.at(-1)
  expect(reply?.role).toBe('assistant')
  expect(reply?.error).toBeFalsy()
  expect(reply?.content).toContain('Available commands')
  expect(reply?.content).toContain('`/help')
  await info.attach('slash-command', { body: JSON.stringify({ conversationId: first.conversationId, requestsAfterCommand: model.exchanges.length - before }), contentType: 'application/json' })
})
