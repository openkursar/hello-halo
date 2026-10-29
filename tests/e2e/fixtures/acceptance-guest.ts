import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { HaloConfig } from '../../../src/renderer/types'
import type { ImChannelInstanceConfig, ImSessionRecord } from '../../../src/shared/types/im-channel'
import { getImSessionDisplayName } from '../../../src/shared/types/im-channel'
import { buildImSessionKey } from '../../../src/shared/apps/im-keys'
import { test as base, expect } from './acceptance-app'
import { startAcceptanceWecom, type AcceptanceWecom } from './acceptance-wecom'
import { openManagedPersonSettings, seedManagedSpace } from './acceptance-management'
import { navigateToSettings } from './helpers'

export const OWNER_ID = 'acceptance-owner'
export const GUEST_ID = 'acceptance-guest'
export const GROUP_ID = 'acceptance-group'
export const OWNER_QUESTION = 'Register the owner contact for this isolated permission test.'
export const OWNER_REPLY = 'The isolated owner contact is ready.'

export interface GuestApp {
  appId: string
  appName: string
  instanceId: string
  spaceId: string
  profile: string
  workDir: string
}

interface GuestFixtures { wecom: AcceptanceWecom; guestApp: GuestApp }

export function guestAcceptance(caseId: string) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'app-e2e', mode: 'scripted', variant: {} }) } }
}

export async function guestConfiguration(page: Page, instanceId: string): Promise<ImChannelInstanceConfig> {
  const response = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getConfig())
  expect(response.success).toBe(true)
  const instance = (response.data as HaloConfig).imChannels?.instances?.find(instance => instance.id === instanceId)
  expect(instance).toBeTruthy()
  return instance!
}

export async function guestChannelCard(page: Page, context: GuestApp): Promise<Locator> {
  if (!(await page.locator('#message-channels').isVisible())) await navigateToSettings(page)
  const section = page.locator('#message-channels')
  await section.scrollIntoViewIfNeeded()
  const provider = section.getByRole('button', { name: /^WeCom Intelligent Bot/ })
  await expect(provider).toHaveCount(1)
  if (await provider.getAttribute('aria-expanded') !== 'true') await provider.click()
  const card = section.locator('div.rounded-lg.bg-card').filter({ has: page.getByRole('switch', { name: 'Enable this channel', exact: true }) })
  await expect(card).toHaveCount(1)
  const header = card.locator('button[aria-expanded]').filter({ has: page.getByText(context.appName, { exact: true }) })
  await expect(header).toHaveCount(1)
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click()
  return card
}

async function switchByText(card: Locator, label: string, value: boolean) {
  const control = card.getByText(label, { exact: true }).locator('xpath=ancestor::*[.//*[@role="switch"]][1]').getByRole('switch')
  await expect(control).toHaveCount(1)
  await expect(control).toHaveAttribute('aria-checked', /^(true|false)$/)
  if (await control.getAttribute('aria-checked') !== String(value)) await control.click()
  await expect(control).toHaveAttribute('aria-checked', String(value))
}

export async function waitForGuestChannel(page: Page, context: GuestApp, wecom: AcceptanceWecom) {
  await expect.poll(async () => {
    const configuration = await guestConfiguration(page, context.instanceId)
    expect(configuration.config.wsUrl).toBe(wecom.url)
    expect(configuration.appId).toBe(context.appId)
    expect(configuration.type).toBe('wecom-bot')
    expect(configuration.owners).toEqual([OWNER_ID])
    const status = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.imChannelsInstanceStatus(id), context.instanceId)
    return status.success && (status.data as { connected?: boolean } | undefined)?.connected === true
  }, { timeout: 30000 }).toBe(true)
  await wecom.awaitAuthenticated()
}

export async function changeGuestPolicy(page: Page, context: GuestApp, wecom: AcceptanceWecom, selection: { notifications?: boolean; readFiles?: boolean }) {
  const card = await guestChannelCard(page, context)
  await switchByText(card, 'Guest Access', true)
  await expect.poll(async () => Boolean((await guestConfiguration(page, context.instanceId)).guestPolicy)).toBe(true)
  if (selection.notifications !== undefined) {
    await switchByText(card, 'Notifications', selection.notifications)
    await expect.poll(async () => (await guestConfiguration(page, context.instanceId)).guestPolicy?.allowNotify ?? false).toBe(selection.notifications)
  }
  if (selection.readFiles !== undefined) {
    await switchByText(card, 'Read files', selection.readFiles)
    await expect.poll(async () => (await guestConfiguration(page, context.instanceId)).guestPolicy?.allowedTools?.includes('Read') ?? false).toBe(selection.readFiles)
  }
  await waitForGuestChannel(page, context, wecom)
}

export async function imTranscript(page: Page, context: GuestApp, chatId: string, chatType: 'direct' | 'group' = 'direct') {
  const conversationId = buildImSessionKey(context.appId, 'wecom-bot', chatType, chatId)
  const result = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), {
    appId: context.appId, spaceId: context.spaceId, conversationId,
  })
  expect(result.success).toBe(true)
  expect(result.data).toBeTruthy()
  return { conversationId, messages: result.data!.messages }
}

export async function waitForImIdle(page: Page, context: GuestApp, chatId: string, chatType: 'direct' | 'group' = 'direct') {
  const conversationId = buildImSessionKey(context.appId, 'wecom-bot', chatType, chatId)
  await expect.poll(async () => {
    const state = await page.evaluate(({ appId, conversationId }) => (window as unknown as { halo: HaloAPI }).halo.appChatSessionState(appId, conversationId), { appId: context.appId, conversationId })
    expect(state.success).toBe(true)
    return (state.data as { isActive: boolean }).isActive
  }, { timeout: 30000 }).toBe(false)
}

export async function showImConversation(page: Page, context: GuestApp, chatId: string, reply: string) {
  const result = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.imSessionsList(appId), context.appId)
  expect(result.success).toBe(true)
  const session = (result.data as ImSessionRecord[]).find(session => session.instanceId === context.instanceId && session.chatId === chatId)
  expect(session).toBeTruthy()
  const history = await imTranscript(page, context, chatId, session!.chatType)
  const message = history.messages.findLast(message => message.role === 'assistant' && message.content.includes(reply))
  expect(message).toBeTruthy()
  await openManagedPersonSettings(page, context.appName)
  const access = page.locator('section[aria-label="Bot Access"]')
  await access.scrollIntoViewIfNeeded()
  const conversations = access.getByRole('button', { name: /\d+ contacts/ })
  await expect(conversations).toHaveCount(1)
  await conversations.click()
  const displayName = getImSessionDisplayName(session!)
  const row = page.getByText(displayName, { exact: true }).locator('xpath=ancestor::div[@role="button"][1]')
    .filter({ hasText: session!.chatType === 'group' ? 'WeCom · Group' : 'WeCom · Direct' })
  await expect(row).toHaveCount(1)
  await row.getByText(displayName, { exact: true }).click()
  const shown = page.locator(`[data-message-id="${message!.id}"]`)
  await expect(shown).toHaveCount(1)
  await expect(shown).toContainText(reply)
}

export const test = base.extend<GuestFixtures>({
  wecom: [async ({}, use, testInfo) => {
    const wecom = await startAcceptanceWecom()
    try { await use(wecom) }
    finally {
      await wecom.close()
      await testInfo.attach('local-wecom-replies', { body: JSON.stringify(wecom.replies, null, 2), contentType: 'application/json' })
      expect(wecom.errors, 'Only the declared local WeCom protocol may be used').toEqual([])
    }
  }, { auto: true }],
  guestApp: async ({ acceptanceApp, wecom }, use) => {
    let window = acceptanceApp.window
    await expect.poll(() => window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.appList({ type: 'automation' }).then(result => result.success)), { timeout: 30000 }).toBe(true)
    const space = await seedManagedSpace(window, 'Guest permission workspace')
    const appName = 'Acceptance permission assistant'
    const installed = await window.evaluate(({ appName, spaceId }) => (window as unknown as { halo: HaloAPI }).halo.appInstall({
      spaceId,
      spec: { spec_version: '1.0', type: 'automation', name: appName, version: '1.0.0', author: 'Acceptance', description: 'An isolated channel permission fixture.', system_prompt: 'Help the sender using the capabilities provided for this turn.', subscriptions: [] },
    }), { appName, spaceId: space.id })
    expect(installed.success).toBe(true)
    const appId = (installed.data as { appId: string }).appId
    const workDir = space.workingDir || space.path
    const within = relative(acceptanceApp.profile, workDir)
    expect(within.length > 0 && !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`)).toBe(true)
    const context: GuestApp = { appId, appName, instanceId: `acceptance-instance-${randomUUID()}`, spaceId: space.id, profile: acceptanceApp.profile, workDir }
    const instance: ImChannelInstanceConfig = {
      id: context.instanceId, type: 'wecom-bot', enabled: false, appId,
      config: { botId: wecom.botId, secret: wecom.secret, wsUrl: wecom.url, nameResolveUrl: '', quoteReply: true },
      replyScope: 'all', permissionEnabled: false, owners: [], streaming: false, processingNotice: false,
    }
    expect(new URL(wecom.url).hostname).toBe('127.0.0.1')
    const added = await window.evaluate(instance => (window as unknown as { halo: HaloAPI }).halo.imChannelsCreateInstance(instance), instance)
    expect(added.success).toBe(true)
    window = await acceptanceApp.restart()
    await expect.poll(() => window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.appList({ type: 'automation' }).then(result => result.success)), { timeout: 30000 }).toBe(true)
    const card = await guestChannelCard(window, context)
    await switchByText(card, 'Permission Control', true)
    const owners = card.locator('label').filter({ hasText: /^Owner User IDs$/ }).locator('..').locator('textarea')
    await owners.fill(OWNER_ID)
    await owners.press('Tab')
    await expect.poll(async () => (await guestConfiguration(window, context.instanceId)).owners).toEqual([OWNER_ID])
    await expect.poll(async () => (await guestConfiguration(window, context.instanceId)).permissionEnabled).toBe(true)
    await switchByText(card, 'Guest Access', false)
    expect((await guestConfiguration(window, context.instanceId)).config.wsUrl).toBe(wecom.url)
    await card.getByRole('switch', { name: 'Enable this channel', exact: true }).click()
    await waitForGuestChannel(window, context, wecom)
    await use(context)
  },
  window: async ({ acceptanceApp, guestApp }, use) => {
    expect(guestApp.profile).toBe(acceptanceApp.profile)
    await use(acceptanceApp.window)
  },
})

export { expect } from '@playwright/test'
