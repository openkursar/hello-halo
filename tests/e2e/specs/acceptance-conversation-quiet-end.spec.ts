import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { test, expect, acceptance, readAcceptanceConversation, readAcceptanceErrors, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { conversationRow, seedManagedConversation } from '../fixtures/acceptance-management'
import type { ModelReply, ModelRequest } from '../fixtures/acceptance-model'
import { navigateToChat, navigateToSettings } from '../fixtures/helpers'

test.setTimeout(120000)

interface ScriptIssue { sequence: number; tool: string; matches: number }

function callTool(request: ModelRequest, tool: string, input: Record<string, unknown>, id: string, issues: ScriptIssue[]): ModelReply {
  const matches = request.tools.filter(name => name === tool || name.endsWith(`__${tool}`))
  if (matches.length !== 1) {
    issues.push({ sequence: request.sequence, tool, matches: matches.length })
    return { text: 'The requested conversation tool was unavailable.' }
  }
  return { tools: [{ name: matches[0], id, input }] }
}

async function openConversation(page: Page, title: string) {
  await navigateToChat(page)
  const row = conversationRow(page, title)
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(page.getByRole('banner').getByText(title, { exact: true })).toBeVisible()
}

test('a notice that needs no reply ends the recipient turn without an error or a blank reply', acceptance('assistant-tools.interop.quiet-end'), async ({ model, window }, info) => {
  await navigateToChat(window)
  const sender = await seedManagedConversation(window, 'halo-temp', 'Notice source', [])
  const target = await seedManagedConversation(window, 'halo-temp', 'Notice recipient', [
    { role: 'user', content: 'Is the release merged?' },
    { role: 'assistant', content: 'Yes, it is merged.' },
  ])
  const notice = `The test account is busy for an hour ${randomUUID()}. No reply needed.`
  const summary = 'The test account is busy'
  const question = `Tell ${target.id}: ${notice}`
  const followUp = `Anything else to check ${randomUUID()}?`
  const requests: Array<{ side: string; request: ModelRequest }> = []
  const issues: ScriptIssue[] = []
  model.respond(request => {
    if (request.text.includes(question)) {
      requests.push({ side: 'source', request })
      if (request.toolResults.some(result => result.id === 'send-notice')) return { text: 'Sent.' }
      return callTool(request, 'conversation_send', { target: target.id, message: notice, summary, waitForReply: false }, 'send-notice', issues)
    }
    requests.push({ side: 'target', request })
    return { silent: true }
  })
  const emptyAnswer = expect.objectContaining({ conversationId: target.id, errorType: 'interrupted', error: expect.stringContaining('Unexpected empty response.') })
  try {
    // Leaving the chat makes it list the conversations seeded through the API.
    await navigateToSettings(window)
    await openConversation(window, sender.title)
    const sent = await sendAcceptanceMessage(window, question)
    expect(sent.conversationId).toBe(sender.id)
    await expect(window.locator('.message-assistant').last()).toContainText('Sent.')
    await waitForAcceptanceIdle(window, sender.id)
    await expect.poll(() => requests.filter(item => item.side === 'target').length).toBe(1)
    await waitForAcceptanceIdle(window, target.id)
    expect(issues).toEqual([])
    expect(requests.filter(item => item.side === 'target')[0].request.text).toContain(`Message from another conversation ("${sender.title}"), not from your user.`)

    const afterNotice = await readAcceptanceConversation(window, 'halo-temp', target.id)
    const delivery = afterNotice.messages.at(-1)!
    expect(delivery).toMatchObject({ role: 'system', source: 'cross-conversation', content: notice })
    expect(afterNotice.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['Yes, it is merged.'])
    for (const visit of ['after the notice', 'reopened']) {
      if (visit === 'reopened') await openConversation(window, sender.title)
      await openConversation(window, target.title)
      await expect(window.locator(`[data-message-id="${delivery.id}"]`), visit).toContainText(`From @${sender.title}:`)
      await expect(window.getByText('Model response interrupted', { exact: true }), visit).toHaveCount(0)
      await expect(window.getByText(/Unexpected empty response/), visit).toHaveCount(0)
      await expect(window.getByRole('button', { name: /^Work process/ }), visit).toHaveCount(0)
    }
    expect(requests.filter(item => item.side === 'target')).toHaveLength(1)

    const asked = await sendAcceptanceMessage(window, followUp)
    expect(asked.conversationId).toBe(target.id)
    await waitForAcceptanceIdle(window, target.id, { expectedErrors: [emptyAnswer] })
    await expect(window.getByText('Model response interrupted', { exact: true })).toBeVisible()
    expect(requests.filter(item => item.side === 'target')).toHaveLength(2)
    expect(await readAcceptanceErrors(window)).toEqual([emptyAnswer])
  } finally {
    await info.attach('quiet-end-boundary', { body: JSON.stringify({ sender: sender.id, target: target.id, notice, followUp, requests, issues }, null, 2), contentType: 'application/json' })
  }
})
