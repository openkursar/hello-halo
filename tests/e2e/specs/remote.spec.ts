import { test, expect } from '../fixtures/electron'
import { navigateToRemoteSettings, clickRemoteToggle } from '../fixtures/helpers'

test.describe('Remote Access', () => {
  test.setTimeout(60000)

  test('can navigate to settings and find remote access section', async ({ window }, testInfo) => {
    await navigateToRemoteSettings(window)
    await expect(window.locator('#remote').getByRole('heading', { name: 'Remote Access', exact: true })).toBeVisible()
    await window.screenshot({ path: testInfo.outputPath('remote-section.png') })
  })

  test('can enable LAN access and get local URL', async ({ window }, testInfo) => {
    await navigateToRemoteSettings(window)
    await clickRemoteToggle(window)
    const remote = window.locator('#remote')
    await expect(remote.getByText('Local Address', { exact: true })).toBeVisible()
    await expect(remote.locator('code').filter({ hasText: /^http:\/\/(localhost|127\.0\.0\.1):/ })).toBeVisible()
    await window.screenshot({ path: testInfo.outputPath('remote-lan-enabled.png') })
  })

  test('can enable tunnel and get public URL', async ({ window }, testInfo) => {
    await navigateToRemoteSettings(window)
    await clickRemoteToggle(window)
    const remote = window.locator('#remote')
    await expect(remote.getByText('Local Address', { exact: true })).toBeVisible()
    await remote.getByRole('button', { name: 'Start Tunnel', exact: true }).click()
    await expect(remote.locator('code').filter({ hasText: /^https:\/\// })).toBeVisible({ timeout: 30000 })
    await expect(remote.getByRole('button', { name: 'Stop Tunnel', exact: true })).toBeVisible()
    const image = remote.getByRole('img', { name: 'QR Code', exact: true })
    await image.scrollIntoViewIfNeeded()
    await expect(image).toBeVisible()
    expect(await image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
    await window.screenshot({ path: testInfo.outputPath('remote-tunnel-enabled.png') })
  })

  test('shows and hides the access password', async ({ window }, testInfo) => {
    await navigateToRemoteSettings(window)
    await clickRemoteToggle(window)
    const remote = window.locator('#remote')
    await expect(remote.getByText('Access Password', { exact: true })).toBeVisible()
    const masked = remote.locator('code').filter({ hasText: /^•+$/ })
    await expect(masked).toBeVisible()
    await remote.getByRole('button', { name: 'Show', exact: true }).click()
    await expect(masked).toHaveCount(0)
    await expect(remote.getByRole('button', { name: 'Hide', exact: true })).toBeVisible()
    await remote.getByRole('button', { name: 'Hide', exact: true }).click()
    await expect(masked).toBeVisible()
    await window.screenshot({ path: testInfo.outputPath('remote-password-masked.png') })
  })

  test('can disable remote access', async ({ window }, testInfo) => {
    await navigateToRemoteSettings(window)
    await clickRemoteToggle(window)
    const address = window.locator('#remote').getByText('Local Address', { exact: true })
    await expect(address).toBeVisible()
    await clickRemoteToggle(window)
    await expect(address).toHaveCount(0)
    await expect(window.locator('#remote').getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    await window.screenshot({ path: testInfo.outputPath('remote-disabled.png') })
  })

  test('keeps the public QR code hidden while LAN access has no running tunnel', async ({ window }, testInfo) => {
    await navigateToRemoteSettings(window)
    await clickRemoteToggle(window)
    const remote = window.locator('#remote')
    await expect(remote.getByText('Local Address', { exact: true })).toBeVisible()
    await expect(remote.getByRole('button', { name: 'Start Tunnel', exact: true })).toBeVisible()
    await expect(remote.getByRole('img', { name: 'QR Code', exact: true })).toHaveCount(0)
    await expect(remote.getByText('Scan to Access', { exact: true })).toHaveCount(0)
    await window.screenshot({ path: testInfo.outputPath('remote-lan-without-public-qr.png') })
  })
})
