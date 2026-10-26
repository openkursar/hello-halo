import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { HaloConfig } from '../../../src/renderer/types'
import type { TranscriptMessage } from '../../../src/shared/types/transcript'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { modelTool } from '../fixtures/acceptance-model'
import { openManagedConversation } from '../fixtures/acceptance-management'
import { navigateToChat, navigateToSettings } from '../fixtures/helpers'

test.setTimeout(90000)

async function history(page: Page, spaceId: string, conversationId: string) {
  const result = await page.evaluate(({ spaceId, conversationId }) => (window as unknown as { halo: HaloAPI }).halo.getConversation(spaceId, conversationId), { spaceId, conversationId })
  expect(result.success).toBe(true)
  return result.data as { id: string; title: string; messages: TranscriptMessage[] }
}

async function onlyConversation(page: Page) {
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.listConversations('halo-temp'))
  expect(result.success).toBe(true)
  const conversations = result.data as Array<{ id: string; title: string }>
  expect(conversations).toHaveLength(1)
  return conversations[0]
}

async function sendPreference(page: Page) {
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getConfig())
  expect(result.success).toBe(true)
  return (result.data as HaloConfig).chat?.sendKeyMode
}

for (const key of ['enter', 'ctrl-enter'] as const) {
  test(`the ${key} send preference separates a newline from submission and remains effective after restart`, acceptance('settings.preferences.send-key', { key }), async ({ acceptanceApp, model, window }) => {
    const message = `First line ${randomUUID()}\nSecond line`
    model.respond(request => {
      expect(request.lastUserText).toContain(message)
      return { text: 'Both lines arrived in one message.' }
    })
    await navigateToSettings(window)
    const appearance = window.locator('#appearance')
    await appearance.scrollIntoViewIfNeeded()
    await appearance.getByRole('button', { name: key === 'enter' ? 'Enter' : 'Ctrl+Enter', exact: true }).click()
    await expect.poll(() => sendPreference(window)).toBe(key)
    await navigateToChat(window)

    for (let pass = 0; pass < 2; pass++) {
      const page = pass === 0 ? window : await acceptanceApp.restart()
      if (pass === 1) await navigateToChat(page)
      const input = page.locator('textarea')
      await input.fill(message.split('\n')[0])
      await input.press(key === 'enter' ? 'Shift+Enter' : 'Enter')
      await expect(input).toHaveValue(`${message.split('\n')[0]}\n`)
      expect(model.exchanges).toHaveLength(pass)
      await input.pressSequentially('Second line')
      await expect(input).toHaveValue(message)
      await input.press(key === 'enter' ? 'Enter' : 'Control+Enter')
      await expect.poll(() => model.exchanges.length).toBe(pass + 1)
      await expect(page.locator('.message-assistant').last()).toContainText('Both lines arrived in one message.')
      const conversation = await onlyConversation(page)
      await waitForAcceptanceIdle(page, conversation.id)
      const saved = await history(page, 'halo-temp', conversation.id)
      expect(saved.messages.filter(item => item.role === 'user').map(item => item.content)).toEqual(Array(pass + 1).fill(message))
      expect(model.exchanges).toHaveLength(pass + 1)
      await expect(input).toHaveValue('')
      expect(await sendPreference(page)).toBe(key)
    }
  })
}

test('an attached local file reaches a real read tool and its reference survives application restart', acceptance('chat.attachments.file'), async ({ acceptanceApp, model, window }) => {
  const file = join(acceptanceApp.profile, '.halo/temp/artifacts', 'selected-evidence.txt')
  const marker = `File evidence ${randomUUID()}`
  writeFileSync(file, `${marker}\n`)
  let readResultSeen = false
  model.respond(request => {
    const result = request.toolResults.find(item => item.id === 'read-selected-file')
    if (!result) {
      expect(request.lastUserText).toContain('<halo_references>')
      expect(request.lastUserText).toContain(`Attached file: ${basename(file)}`)
      return { tools: [modelTool(request, 'Read', { file_path: file }, 'read-selected-file')] }
    }
    expect(result.error).toBe(false)
    expect(result.text).toContain(marker)
    readResultSeen = true
    return { text: `The selected file contains: ${marker}` }
  })
  await navigateToChat(window)
  await window.locator('input[type="file"]').setInputFiles(file)
  await expect(window.getByRole('button', { name: `Remove ${basename(file)}`, exact: true })).toBeVisible()
  const turn = await sendAcceptanceMessage(window, 'Read the attached file and report its unique evidence.')
  await expect(window.locator('.message-assistant').last()).toContainText(marker)
  await waitForAcceptanceIdle(window, turn.conversationId)
  expect(readResultSeen).toBe(true)
  const saved = await history(window, turn.spaceId, turn.conversationId)
  const user = saved.messages.find(item => item.role === 'user')!
  expect(user.metadata?.references).toEqual([
    expect.objectContaining({ source: { kind: 'path', path: file, isDirectory: false } }),
  ])
  expect(readFileSync(file, 'utf8')).toBe(`${marker}\n`)
  const reopened = await acceptanceApp.restart()
  await openManagedConversation(reopened, saved.title, turn.spaceId)
  expect((await history(reopened, turn.spaceId, turn.conversationId)).messages).toEqual(saved.messages)
  const message = reopened.locator(`[data-message-id="${user.id}"]`)
  await expect(message).toHaveCount(1)
  const attachment = message.getByTitle(file, { exact: true })
  await expect(attachment).toBeVisible()
  await expect(attachment.getByRole('button', { name: basename(file), exact: true })).toBeVisible()
  expect(readFileSync(file, 'utf8')).toBe(`${marker}\n`)
})

for (const kind of ['image', 'file'] as const) {
  test(`removing a pending ${kind} preserves the draft and excludes the attachment from the model and stored history`, acceptance('chat.attachments.remove', { kind }), async ({ acceptanceApp, model, window }) => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64')
    const file = join(acceptanceApp.profile, '.halo/temp/artifacts', `removed-${randomUUID()}.txt`)
    const marker = `Excluded file content ${randomUUID()}`
    writeFileSync(file, marker)
    const draft = 'Send only this typed text after I remove the attachment.'
    model.respond(request => {
      expect(request.lastUserText).toContain(draft)
      const parts = request.messages.filter(item => item.role === 'user').flatMap(item => Array.isArray(item.content) ? item.content : [])
      expect(parts.filter(part => part.type === 'image' || part.type === 'image_url')).toEqual([])
      expect(request.text).not.toContain(file)
      expect(request.text).not.toContain(basename(file))
      expect(request.text).not.toContain(marker)
      return { text: 'Only the typed text arrived.' }
    })
    await navigateToChat(window)
    await window.locator('textarea').fill(draft)
    await window.locator('input[type="file"]').setInputFiles(kind === 'file' ? file : { name: 'removed-image.png', mimeType: 'image/png', buffer: png })
    const remove = kind === 'file'
      ? window.getByRole('button', { name: `Remove ${basename(file)}`, exact: true })
      : window.getByTitle('Remove image', { exact: true })
    await expect(remove).toBeVisible()
    await remove.click()
    await expect(remove).toHaveCount(0)
    await expect(window.locator('textarea')).toHaveValue(draft)
    const turn = await sendAcceptanceMessage(window, draft)
    await expect(window.locator('.message-assistant').last()).toContainText('Only the typed text arrived.')
    await waitForAcceptanceIdle(window, turn.conversationId)
    const saved = await history(window, turn.spaceId, turn.conversationId)
    const user = saved.messages.find(item => item.role === 'user')!
    expect(user.content).toBe(draft)
    expect(user.images ?? []).toEqual([])
    expect(user.metadata?.references ?? []).toEqual([])
    expect(model.exchanges).toHaveLength(1)
    expect(readFileSync(file, 'utf8')).toBe(marker)
    const reopened = await acceptanceApp.restart()
    expect((await history(reopened, turn.spaceId, turn.conversationId)).messages).toEqual(saved.messages)
  })
}
