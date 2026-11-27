import { randomUUID } from 'node:crypto'
import { mkdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { EmailChannelConfig } from '../../../src/shared/types/notification-channels'
import { startAcceptanceSmtp } from '../fixtures/acceptance-mail-smtp'
import { test, expect, managementAcceptance } from '../fixtures/acceptance-management'
import { navigateToSettings, setTheme } from '../fixtures/helpers'

const loopback = '127.0.0.1'
const pad = (value: string) => ` \u00a0\u200b${value}\u2060\u3000 `

async function openEmailSettings(page: Page) {
  await navigateToSettings(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Message Channels', exact: true }).click()
  const section = page.locator('#message-channels')
  const cardButton = section.getByRole('button', { name: /^Email\b/ })
  await cardButton.click()
  return cardButton.locator('..')
}

async function readEmailSettings(page: Page) {
  return page.evaluate(async () => {
    const result = await (window as unknown as { halo: HaloAPI }).halo.getConfig()
    if (!result.success) throw new Error('The real Settings API could not read configuration')
    const { email } = (result.data as { notificationChannels?: { email?: EmailChannelConfig } }).notificationChannels ?? {}
    return {
      host: email?.smtp.host,
      user: email?.smtp.user,
      recipient: email?.defaultTo,
      passwordMasked: email?.smtp.password === '***',
    }
  })
}

const user = 'owner@acceptance.test'
const recipient = 'recipient@acceptance.test'
const editedRecipient = 'other-recipient@acceptance.test'

const emailTest = test.extend<{
  emailSmtp: {
    nextPassword: string
    receipts: Awaited<ReturnType<typeof startAcceptanceSmtp>>['receipts']
    authResults(): Array<{ status: number; account?: 'primary' | 'control' }>
  }
}>({
  emailSmtp: async ({ managementApp, window }, use, info) => {
    // Both passwords are valid for this user, so a stale saved password cannot produce the expected 535.
    const accounts = {
      primary: { user, password: `local-only-${randomUUID()}` },
      control: { user, password: `local-only-${randomUUID()}` },
    }
    const smtp = await startAcceptanceSmtp({ directory: managementApp.profile, accounts, recipients: [recipient, editedRecipient] })
    try {
      const configured = await window.evaluate(async (email: EmailChannelConfig) => {
        return (await (window as unknown as { halo: HaloAPI }).halo.setConfig({ notificationChannels: { email } })).success
      }, {
        enabled: true,
        smtp: { host: pad(loopback), port: smtp.port, secure: false, ...accounts.control, user: pad(user) },
        defaultTo: editedRecipient,
      })
      expect(configured).toBe(true)
      await window.reload()
      const authResults = () => smtp.receipts.filter(receipt => receipt.command === 'AUTH').map(({ status, account }) => ({ status, account }))
      await use({ nextPassword: accounts.primary.password, receipts: smtp.receipts, authResults })
      expect(smtp.receipts.filter(({ command }) => command === 'MAIL' || command === 'RCPT' || command === 'DATA')).toEqual([])
      expect(smtp.readMessages()).toEqual([])
      expect(smtp.errors).toEqual([])
    } finally {
      await smtp.close()
      await info.attach('email-settings-smtp-receipts', {
        body: JSON.stringify({ receipts: smtp.receipts, errors: smtp.errors }, null, 2), contentType: 'application/json',
      })
    }
  },
})

async function freezeAutosaveClock(page: Page) {
  // Freeze only the renderer clock so autosave cannot win the race against Test.
  const start = Date.now()
  await page.clock.install({ time: start })
  await page.clock.pauseAt(start + 60_000)
}

emailTest('Email settings preserve pasted credentials and Test immediately uses the corrected password without sending mail', managementAcceptance('settings.email.paste-and-test'), async ({ window, emailSmtp }) => {
  const insertText = async (input: Locator, text: string) => {
    await input.selectText()
    await window.keyboard.insertText(text)
  }
  const card = await openEmailSettings(window)
  const password = card.locator('input[type="password"]')
  const warning = card.getByText('This password contains spaces or invisible characters. Halo will use it as entered.', { exact: true })
  const testButton = card.getByRole('button', { name: 'Test', exact: true })
  const success = card.getByText('Test passed', { exact: true })
  const failure = card.getByText(/\b535\b/)
  const savedFields = { host: loopback, user, recipient, passwordMasked: true }
  await password.evaluate(input => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'first\nsecond')
    if (input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))) {
      throw new Error('Multiline paste was not rejected')
    }
  })
  await expect(card.getByText('The pasted password contains a line break. Paste the password on one line.')).toBeVisible()
  await expect(testButton).toBeDisabled()
  {
    const fields = [
      ['SMTP Host', '127.\u200b 0.0.1', loopback],
      ['Username', 'own\u200b er@acceptance.test', user],
      ['Default Recipient', 'recip\u200b ient@acceptance.test', recipient],
    ] as const
    for (const [label, interior] of fields) {
      const input = card.getByRole('textbox', { name: label, exact: true })
      await insertText(input, pad(interior))
      await input.blur()
      await expect(input).toHaveValue(interior)
    }
    await expect.poll(() => readEmailSettings(window)).toEqual({
      host: fields[0][1], user: fields[1][1], recipient: fields[2][1], passwordMasked: true,
    })
    for (const [label, , clean] of fields) {
      const input = card.getByRole('textbox', { name: label, exact: true })
      await insertText(input, pad(clean))
      await input.blur()
      await expect(input).toHaveValue(clean)
    }
    await expect.poll(() => readEmailSettings(window)).toEqual(savedFields)

    const paddedPassword = pad(emailSmtp.nextPassword)
    await insertText(password, paddedPassword)
    expect(await password.inputValue() === paddedPassword, 'The pasted password stays exactly as entered').toBe(true)
    await expect(warning).toBeVisible()
    await testButton.click()
    await expect(failure).toBeVisible()
    expect(emailSmtp.authResults()).toEqual([{ status: 535, account: undefined }])
    await expect(warning).toBeVisible()
    const viewport = window.viewportSize() ?? { width: 1280, height: 900 }
    for (const width of [390, 1280]) {
      await window.setViewportSize({ width, height: 900 })
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(window, theme)
        const name = `email-settings-${width}-${theme}`
        const path = emailTest.info().outputPath(`${name}.png`)
        await card.screenshot({ path, animations: 'disabled' })
        await emailTest.info().attach(name, { path, contentType: 'image/png' })
      }
    }
    await window.setViewportSize(viewport)

    await expect(testButton).toBeEnabled()
    await freezeAutosaveClock(window)
    try {
      await insertText(password, emailSmtp.nextPassword)
      await testButton.click()
      await expect(success).toBeVisible()
      await expect(warning).toBeHidden()
      expect(emailSmtp.authResults()).toEqual([{ status: 535, account: undefined }, { status: 235, account: 'primary' }])
    } finally {
      await window.clock.resume()
    }
  }

  await window.reload()
  const reopened = await openEmailSettings(window)
  const defaultRecipient = reopened.getByRole('textbox', { name: 'Default Recipient', exact: true })
  await expect(defaultRecipient).toHaveValue(recipient)
  await defaultRecipient.fill(editedRecipient)
  await defaultRecipient.blur()
  await expect.poll(() => readEmailSettings(window)).toEqual({ ...savedFields, recipient: editedRecipient })
  await reopened.getByRole('button', { name: 'Test', exact: true }).click()
  await expect(reopened.getByText('Test passed', { exact: true })).toBeVisible()
  expect(emailSmtp.authResults()).toEqual([
    { status: 535, account: undefined },
    { status: 235, account: 'primary' },
    { status: 235, account: 'primary' },
  ])
})

emailTest('Email refuses to test unsaved settings, keeps the draft, and can retry after a real write failure', managementAcceptance('settings.email.save-before-test'), async ({ managementApp, window, emailSmtp }) => {
  const card = await openEmailSettings(window)
  const defaultRecipient = card.getByRole('textbox', { name: 'Default Recipient', exact: true })
  const testButton = card.getByRole('button', { name: 'Test', exact: true })
  const saveError = card.getByText('Could not save these settings. Your changes are still here; try again.', { exact: true })
  await expect(defaultRecipient).toHaveValue(editedRecipient)
  await expect(testButton).toBeEnabled()

  await freezeAutosaveClock(window)
  try {
    // Block only the atomic write, leaving the old configuration readable and usable by SMTP.
    const tempPath = join(managementApp.profile, '.halo', 'config.json.tmp')
    await mkdir(tempPath)
    try {
      await defaultRecipient.fill(recipient)
      await testButton.click()
      await expect(saveError).toBeVisible()
      await expect(defaultRecipient).toHaveValue(recipient)
      expect(await readEmailSettings(window)).toEqual({ host: pad(loopback), user: pad(user), recipient: editedRecipient, passwordMasked: true })
      expect(emailSmtp.receipts).toEqual([])
    } finally {
      await rmdir(tempPath)
    }
    await testButton.click()
    await expect(card.getByText('Test passed', { exact: true })).toBeVisible()
    await expect(saveError).toBeHidden()
    expect(await readEmailSettings(window)).toEqual({ host: pad(loopback), user: pad(user), recipient, passwordMasked: true })
    expect(emailSmtp.authResults()).toEqual([{ status: 235, account: 'control' }])
  } finally {
    await window.clock.resume()
  }
})
