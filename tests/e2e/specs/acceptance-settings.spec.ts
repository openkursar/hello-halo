import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { HaloConfig } from '../../../src/renderer/types'
import {
  test, expect, managementAcceptance, seedManagedConversation, openManagedConversation,
  readManagedConversation,
} from '../fixtures/acceptance-management'
import { navigateToSettings } from '../fixtures/helpers'

test.setTimeout(90000)

async function configuration(page: Page) {
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getConfig())
  expect(result.success).toBe(true)
  return result.data as HaloConfig
}

test('appearance choices survive restart and changing them preserves the current unsent draft', managementAcceptance('settings.preferences.appearance'), async ({ managementApp, window }) => {
  const conversation = await seedManagedConversation(window, 'halo-temp', 'Preference history', [
    { role: 'user', content: 'Keep this saved preference-test question.' },
    { role: 'assistant', content: 'Keep this saved preference-test answer.' },
  ])
  await window.reload()
  await openManagedConversation(window, conversation.title)
  const draft = 'This unsent draft belongs to the current conversation.'
  await window.locator('textarea').fill(draft)
  await navigateToSettings(window)
  const appearance = window.locator('#appearance')
  await appearance.scrollIntoViewIfNeeded()
  await appearance.getByRole('button', { name: 'Light', exact: true }).click()
  await expect(window.locator('html')).toHaveClass(/\blight\b/)
  await expect.poll(async () => (await configuration(window)).appearance.theme).toBe('light')

  const scale = appearance.getByRole('slider', { name: 'Display Size', exact: true })
  await expect(scale).toHaveValue('1')
  await scale.focus()
  await scale.press('ArrowRight')
  await expect(scale).toHaveValue('1.1')
  await expect.poll(() => window.evaluate(async () => (await (window as unknown as { halo: HaloAPI }).halo.getDisplayScale()).data)).toBe(1.1)
  const native = await managementApp.app.browserWindow(window)
  expect(await native.evaluate(browserWindow => browserWindow.webContents.getZoomFactor())).toBeCloseTo(1.1)
  await native.dispose()

  await appearance.locator('select').selectOption('zh-CN')
  await expect(appearance.getByRole('heading', { name: '外观', exact: true })).toBeVisible()
  await window.locator('nav').getByRole('button', { name: '会话', exact: true }).click()
  await expect(window.locator('textarea')).toHaveValue(draft)
  expect((await readManagedConversation(window, 'halo-temp', conversation.id)).messages).toEqual(conversation.messages)

  const reopened = await managementApp.restart()
  await reopened.getByRole('button', { name: '设置', exact: true }).click()
  const restored = reopened.locator('#appearance')
  await restored.scrollIntoViewIfNeeded()
  await expect(restored.locator('select')).toHaveValue('zh-CN')
  await expect(restored.getByRole('heading', { name: '外观', exact: true })).toBeVisible()
  await expect(restored.locator('input[type="range"]')).toHaveValue('1.1')
  await expect(reopened.locator('html')).toHaveClass(/\blight\b/)
  expect((await configuration(reopened)).appearance.theme).toBe('light')
  const restoredNative = await managementApp.app.browserWindow(reopened)
  expect(await restoredNative.evaluate(browserWindow => browserWindow.webContents.getZoomFactor())).toBeCloseTo(1.1)
  await restoredNative.dispose()
  expect((await readManagedConversation(reopened, 'halo-temp', conversation.id)).messages).toEqual(conversation.messages)
})

test('invalid proxy input reports the reason and preserves the last saved route across restart', managementAcceptance('settings.network.validation'), async ({ managementApp, window }) => {
  const sockets = new Set<Socket>()
  const proxy = createServer((_request, response) => { response.writeHead(502).end('Isolated acceptance proxy') })
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  proxy.on('connect', (_request, socket) => { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') })
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve) })
  const address = proxy.address()
  if (!address || typeof address === 'string') throw new Error('The isolated proxy has no TCP address')
  const saved = `http://127.0.0.1:${address.port}`
  try {
    await navigateToSettings(window)
    const system = window.locator('#system')
    await system.scrollIntoViewIfNeeded()
    const proxyInput = system.getByPlaceholder('http://127.0.0.1:1087', { exact: true })
    await proxyInput.fill(saved)
    await proxyInput.press('Enter')
    await expect.poll(async () => (await configuration(window)).network?.proxy).toBe(saved)
    for (const [value, error] of [
      ['ftp://127.0.0.1:21', 'Unsupported protocol. Use http://, https://'],
      ['not a proxy URL', 'Invalid proxy URL. Example: http://127.0.0.1:1087'],
    ]) {
      await proxyInput.fill(value)
      await proxyInput.press('Enter')
      await expect(system.getByText(error, { exact: true })).toBeVisible()
      expect((await configuration(window)).network?.proxy).toBe(saved)
    }
    const reopened = await managementApp.restart()
    await navigateToSettings(reopened)
    await expect(reopened.locator('#system').getByPlaceholder('http://127.0.0.1:1087', { exact: true })).toHaveValue(saved)
    expect((await configuration(reopened)).network?.proxy).toBe(saved)
  } finally {
    for (const socket of sockets) socket.destroy()
    proxy.closeAllConnections()
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
  }
})

test('browser cleanup cancels safely and then clears shared login data while preserving other sessions and Halo work', managementAcceptance('settings.safety.clear-browser'), async ({ managementApp, window }) => {
  const conversation = await seedManagedConversation(window, 'halo-temp', 'Browser cleanup history', [
    { role: 'user', content: 'This saved Halo history is unrelated to website logins.' },
    { role: 'assistant', content: 'Keep this history after clearing the shared browser.' },
  ])
  const file = join(managementApp.profile, '.halo/temp/artifacts', 'browser-cleanup-control.txt')
  writeFileSync(file, 'Unrelated workspace file.\n')
  const url = 'https://acceptance.invalid/'
  const partitions = ['persist:browser', 'persist:acceptance-control']
  await managementApp.app.evaluate(async ({ session }, { partitions, url }) => {
    for (const partition of partitions) {
      const store = session.fromPartition(partition)
      await store.cookies.set({ url, name: 'acceptance-login', value: partition, expirationDate: Math.floor(Date.now() / 1000) + 3600 })
      await store.cookies.flushStore()
    }
  }, { partitions, url })
  const cookies = () => managementApp.app.evaluate(async ({ session }, { partitions, url }) => Promise.all(partitions.map(async partition => ({
    partition, values: (await session.fromPartition(partition).cookies.get({ url, name: 'acceptance-login' })).map(cookie => cookie.value),
  }))), { partitions, url })
  const initial = await cookies()
  expect(initial).toEqual(partitions.map(partition => ({ partition, values: [partition] })))
  await navigateToSettings(window)
  const system = window.locator('#system')
  await system.scrollIntoViewIfNeeded()
  await system.getByRole('button', { name: 'Clear browser data', exact: true }).click()
  const confirm = window.getByRole('alertdialog', { name: 'Clear browser data?', exact: true })
  await expect(confirm).toContainText('ALL shared browser site logins')
  await expect(confirm).toContainText('Halo data and other browser sessions are kept')
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await cookies()).toEqual(initial)
  await system.getByRole('button', { name: 'Clear browser data', exact: true }).click()
  await confirm.getByRole('button', { name: 'Clear browser data', exact: true }).click()
  await expect(system.getByText('Browser data cleared.', { exact: true })).toBeVisible()
  const cleared = [{ partition: partitions[0], values: [] }, { partition: partitions[1], values: [partitions[1]] }]
  await expect.poll(cookies).toEqual(cleared)
  expect((await readManagedConversation(window, 'halo-temp', conversation.id)).messages).toEqual(conversation.messages)
  expect(readFileSync(file, 'utf8')).toBe('Unrelated workspace file.\n')
  const reopened = await managementApp.restart()
  expect(await cookies()).toEqual(cleared)
  expect((await readManagedConversation(reopened, 'halo-temp', conversation.id)).messages).toEqual(conversation.messages)
  expect(readFileSync(file, 'utf8')).toBe('Unrelated workspace file.\n')
})
