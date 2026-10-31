import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/acceptance-remote'
import { acceptance } from '../fixtures/acceptance-app'
import { createModelGate } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'
import type { HaloAPI } from '../../../src/preload'

async function sendRemote(page: Page, message: string) {
  await page.locator('textarea').first().fill(message)
  await page.locator('[data-onboarding="send-button"]').click()
}

test('remote web login, streaming and reconnection preserve the conversation', acceptance('remote.session.chat-reconnect'), async ({ model, remote }) => {
  test.setTimeout(120000)
  const gate = createModelGate()
  model.respond(request => {
    if (request.lastUserText.includes('Start my remote conversation.')) return { text: 'Your remote answer is streaming.', hold: gate.promise }
    if (request.lastUserText.includes('Continue after reconnecting.')) {
      expect(request.text).toContain('Start my remote conversation.')
      return { text: 'Your remote conversation continued after reconnecting.' }
    }
    throw new Error(`Unexpected remote chat request ${request.sequence}`)
  })
  await remote.login()
  await navigateToChat(remote.page)
  await sendRemote(remote.page, 'Start my remote conversation.')
  await expect(remote.page.locator('.message-assistant').last()).toContainText('Your remote answer is streaming.')
  await expect(remote.page.getByTitle('Stop generation (Esc)', { exact: true })).toBeVisible()
  expect(model.exchanges[0]?.completed).toBe(false)
  gate.release()
  await expect(remote.page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
  remote.disconnect()
  await expect(remote.page.getByText('Reconnecting...', { exact: true })).toBeVisible()
  remote.reconnect()
  await expect(remote.page.getByText('Reconnecting...', { exact: true })).toHaveCount(0, { timeout: 30000 })
  await expect(remote.page.locator('.message-user')).toHaveCount(1)
  await expect(remote.page.locator('.message-assistant')).toHaveCount(1)
  await sendRemote(remote.page, 'Continue after reconnecting.')
  await expect(remote.page.locator('.message-assistant').last()).toContainText('Your remote conversation continued after reconnecting.')
  await expect(remote.page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
  await expect(remote.page.locator('.message-user')).toHaveCount(2)
  await remote.page.reload()
  await navigateToChat(remote.page)
  await remote.page.getByText('Start my remote conversation.', { exact: true }).first().click()
  await expect(remote.page.locator('.message-assistant').last()).toContainText('Your remote conversation continued after reconnecting.')
})

test('rotating the access code rejects old browser requests and requires a fresh UI login', acceptance('remote.access.rotate'), async ({ acceptanceApp, model, remote }) => {
  test.setTimeout(120000)
  model.respond(request => {
    if (request.lastUserText.includes('Confirm my original remote login.')) return { text: 'Your original remote login works.' }
    if (request.lastUserText.includes('Confirm my renewed remote login.')) return { text: 'Your renewed remote login works.' }
    throw new Error(`An unauthorized or unexpected remote message reached the model: ${request.sequence}`)
  })
  await remote.login()
  await navigateToChat(remote.page)
  await sendRemote(remote.page, 'Confirm my original remote login.')
  await expect(remote.page.locator('.message-assistant').last()).toContainText('Your original remote login works.')
  await expect(remote.page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
  const oldCode = await remote.page.evaluate(() => localStorage.getItem('halo_remote_token'))
  const changed = await acceptanceApp.window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.regenerateRemotePassword())
  expect(changed.success).toBe(true)
  const newCode = (changed.data as { server: { token: string } }).server.token
  expect(newCode === oldCode).toBe(false)
  await sendRemote(remote.page, 'This old connection must not start work.')
  await expect(remote.page.getByPlaceholder('Access Code', { exact: true })).toBeVisible({ timeout: 30000 })
  expect(model.exchanges).toHaveLength(1)
  await remote.page.getByPlaceholder('Access Code', { exact: true }).fill(oldCode!)
  await remote.page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(remote.page.getByText('Invalid code', { exact: true })).toBeVisible()
  await remote.login(newCode)
  await navigateToChat(remote.page)
  await sendRemote(remote.page, 'Confirm my renewed remote login.')
  await expect(remote.page.locator('.message-assistant').last()).toContainText('Your renewed remote login works.')
  await expect(remote.page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
  expect(model.exchanges).toHaveLength(2)
})
