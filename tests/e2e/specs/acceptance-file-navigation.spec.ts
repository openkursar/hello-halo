import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  test, expect, managementAcceptance, openManagedConversation, readManagedConversation, seedManagedConversation,
} from '../fixtures/acceptance-management'
import { boundsInsideViewport, expectFileAnchor, resizeFileWindow, settleFileAnchor } from '../fixtures/acceptance-file-navigation'
import { clickArtifactByName } from '../../perf/lib/open-artifact'

test.setTimeout(120000)

async function prepareFileNavigation(page: Page, profile: string) {
  const token = randomUUID().slice(0, 8)
  const directory = join(profile, '.halo', 'temp', 'artifacts')
  mkdirSync(directory, { recursive: true })
  const files = ['Alpha', 'Beta'].map(label => {
    const name = `${label.toLowerCase()}-reading.txt`
    const lines = Array.from({ length: 600 }, (_, index) => `${label} ${String(index + 1).padStart(4, '0')} ${token}`)
    const content = lines.join('\n') + '\n'
    const path = join(directory, name)
    writeFileSync(path, content)
    return { name, lines, content, path }
  })
  const original = await seedManagedConversation(page, 'halo-temp', 'Canvas reading discussion', [
    { role: 'user', content: `Keep the original canvas question ${token}.` },
    { role: 'assistant', content: `Keep the original canvas answer ${token}.` },
  ])
  const control = await seedManagedConversation(page, 'halo-temp', 'Separate canvas discussion', [
    { role: 'user', content: `Leave this separate question ${token} unchanged.` },
    { role: 'assistant', content: `This separate answer ${token} is not selected.` },
  ])
  await page.reload({ waitUntil: 'domcontentloaded' })
  const draft = `Keep this unsent canvas draft 中文🙂 ${token}`
  await openManagedConversation(page, original.title)
  await page.locator('textarea').first().fill(draft)
  const assertRetained = async () => {
    await expect(page.locator('textarea').first()).toHaveValue(draft)
    for (const message of original.messages) await expect(page.locator(`[data-message-id="${message.id}"]`).first()).toContainText(message.content)
    for (const message of control.messages) await expect(page.locator(`[data-message-id="${message.id}"]`)).toHaveCount(0)
    expect((await readManagedConversation(page, 'halo-temp', original.id)).messages).toEqual(original.messages)
    expect((await readManagedConversation(page, 'halo-temp', control.id)).messages).toEqual(control.messages)
    for (const file of files) expect(readFileSync(file.path, 'utf8')).toBe(file.content)
  }
  return { files, original, control, draft, assertRetained }
}

async function selectReadingTab(page: Page, name: string) {
  const tab = page.locator('.canvas-tab').filter({ has: page.getByTitle(name, { exact: true }) })
  await expect(tab).toHaveCount(1)
  await tab.click()
  await expect(page.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(name)
  await expect(page.locator('.cm-scroller:visible')).toHaveCount(1)
}

test('two file tabs keep their distinct reading positions across switching and canvas collapse', managementAcceptance('files.navigation.tabs'), async ({ managementApp, window }, info) => {
  const prepared = await prepareFileNavigation(window, managementApp.profile)
  const viewport = await resizeFileWindow(managementApp.app, window, 1280, 800)
  const [first, second] = prepared.files
  const observations: Array<Record<string, unknown>> = []
  try {
    await clickArtifactByName(window, first.name)
    const scroller = window.locator('.cm-scroller:visible')
    await expect(scroller).toHaveCount(1)
    await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(3000)
    await scroller.hover()
    await window.mouse.wheel(0, 960)
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(500)
    const firstAnchor = await settleFileAnchor(window, scroller)
    expect(first.lines).toContain(firstAnchor.text)
    observations.push({ phase: 'first-position', ...firstAnchor })

    await clickArtifactByName(window, second.name)
    await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(second.name)
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2)
    await scroller.hover()
    await window.mouse.wheel(0, 1760)
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(1000)
    const secondAnchor = await settleFileAnchor(window, scroller)
    expect(second.lines).toContain(secondAnchor.text)
    expect(Math.abs(secondAnchor.scrollTop - firstAnchor.scrollTop)).toBeGreaterThan(300)
    observations.push({ phase: 'second-position', ...secondAnchor })
    await expect(window.locator('.canvas-tab')).toHaveCount(2)

    await selectReadingTab(window, first.name)
    observations.push({ phase: 'first-restored', ...await expectFileAnchor(window, scroller, firstAnchor) })
    await selectReadingTab(window, second.name)
    observations.push({ phase: 'second-restored', ...await expectFileAnchor(window, scroller, secondAnchor) })
    await prepared.assertRetained()

    await window.getByRole('button', { name: 'Collapse canvas', exact: true }).click()
    await expect(scroller).toHaveCount(0)
    const expand = window.getByRole('button', { name: 'Expand canvas', exact: true })
    await expect(expand).toBeVisible()
    await expect(expand).toHaveText('2')
    await prepared.assertRetained()
    await expand.click()
    await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(second.name)
    await expect(window.locator('.canvas-tab')).toHaveCount(2)
    observations.push({ phase: 'expanded-second', ...await expectFileAnchor(window, scroller, secondAnchor) })
    await selectReadingTab(window, first.name)
    observations.push({ phase: 'expanded-first', ...await expectFileAnchor(window, scroller, firstAnchor) })
    await prepared.assertRetained()
  } finally {
    await info.attach('file-tab-reading-positions', { body: JSON.stringify({ viewport, conversationId: prepared.original.id, controlConversationId: prepared.control.id, observations }, null, 2), contentType: 'application/json' })
  }
})

test('fullscreen and a native 375px canvas overlay return to the same conversation and unsent draft', managementAcceptance('files.navigation.narrow'), async ({ managementApp, window }, info) => {
  const prepared = await prepareFileNavigation(window, managementApp.profile)
  const file = prepared.files[0]
  const observations: Array<Record<string, unknown>> = []
  try {
    observations.push({ phase: 'desktop', ...await resizeFileWindow(managementApp.app, window, 1280, 800) })
    await clickArtifactByName(window, file.name)
    await expect(window.locator('.cm-line').filter({ hasText: file.lines[0] })).toBeVisible()
    await window.getByTitle('Enter fullscreen', { exact: true }).click()
    const desktopExit = window.getByRole('button', { name: 'Exit fullscreen and return to chat', exact: true })
    observations.push({ phase: 'fullscreen-exit', ...await boundsInsideViewport(window, desktopExit) })
    await expect(window.locator('textarea:visible')).toHaveCount(0)
    await expect(window.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(file.name)
    await desktopExit.click()
    await expect(desktopExit).toHaveCount(0)
    await expect(window.getByTitle('Enter fullscreen', { exact: true })).toBeVisible()
    await prepared.assertRetained()
    await window.getByRole('button', { name: 'Collapse canvas', exact: true }).click()
    await expect(window.getByRole('button', { name: 'Expand canvas', exact: true })).toBeVisible()

    observations.push({ phase: 'narrow', ...await resizeFileWindow(managementApp.app, window, 375, 844) })
    await prepared.assertRetained()
    await clickArtifactByName(window, file.name)
    await window.getByRole('button', { name: 'Close', exact: true }).click()
    const returnToChat = window.getByRole('button', { name: 'Return to conversation', exact: true })
    const overlay = returnToChat.locator('xpath=../..')
    const content = overlay.locator('.cm-scroller')
    await expect(overlay.locator('.canvas-tab.active .canvas-tab-title')).toHaveText(file.name)
    observations.push({ phase: 'narrow-overlay', ...await boundsInsideViewport(window, overlay) })
    observations.push({ phase: 'narrow-return', ...await boundsInsideViewport(window, returnToChat) })
    observations.push({ phase: 'narrow-content', ...await boundsInsideViewport(window, content) })
    const reading = await settleFileAnchor(window, content)
    expect(file.lines).toContain(reading.text)
    const visibleLine = content.locator('.cm-line').filter({ hasText: reading.text })
    observations.push({ phase: 'narrow-reading-line', ...await boundsInsideViewport(window, visibleLine), text: reading.text })
    expect(await returnToChat.evaluate(element => {
      const box = element.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return hit === element || !!hit && element.contains(hit)
    })).toBe(true)
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await info.attach('narrow-canvas-overlay', { body: await window.screenshot(), contentType: 'image/png' })
    await returnToChat.click()
    await expect(returnToChat).toHaveCount(0)
    await expect(window.locator('.cm-scroller:visible')).toHaveCount(0)
    await prepared.assertRetained()
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await info.attach('canvas-layout-navigation', { body: JSON.stringify({ conversationId: prepared.original.id, controlConversationId: prepared.control.id, observations }, null, 2), contentType: 'application/json' })
  }
})
