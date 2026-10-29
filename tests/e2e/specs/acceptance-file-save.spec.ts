import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { modelTool } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'
import { clickArtifactByName } from '../../perf/lib/open-artifact'

test('saving a canvas edit changes only the selected file and reopening shows the saved text', acceptance('files.edit.save'), async ({ acceptanceApp, model, window }, info) => {
  test.setTimeout(90000)
  const target = join(acceptanceApp.profile, '.halo', 'temp', 'artifacts', 'saved-note.ts')
  const control = join(acceptanceApp.profile, '.halo', 'temp', 'artifacts', 'control-note.txt')
  const initial = 'export const decision = "draft"\nexport const quantity = 7\n'
  const saved = initial.replace('"draft"', '"saved by the owner"')
  const controlText = 'This independent file must remain unchanged.\n'
  const requestText = 'Create the editable note and its independent control file.'
  let receipts: Array<{ id: string; error: boolean; text: string }> = []
  expect(existsSync(target)).toBe(false)
  expect(existsSync(control)).toBe(false)
  model.respond(request => {
    if (!request.text.includes(requestText)) throw new Error(`Unexpected file-save preparation request ${request.sequence}`)
    const writes = request.toolResults.filter(result => ['write-save-target', 'write-save-control'].includes(result.id))
    if (!writes.length) return { tools: [
      modelTool(request, 'Write', { file_path: target, content: initial }, 'write-save-target'),
      modelTool(request, 'Write', { file_path: control, content: controlText }, 'write-save-control'),
    ] }
    receipts = writes
    return { text: 'Both editable files are ready.' }
  })
  await navigateToChat(window)
  const turn = await sendAcceptanceMessage(window, requestText)
  await expect(window.locator('.message-assistant').last()).toContainText('Both editable files are ready.')
  await waitForAcceptanceIdle(window, turn.conversationId)
  expect(receipts.map(receipt => receipt.id).sort()).toEqual(['write-save-control', 'write-save-target'])
  expect(receipts.every(receipt => !receipt.error)).toBe(true)
  expect(readFileSync(target, 'utf8')).toBe(initial)
  expect(readFileSync(control, 'utf8')).toBe(controlText)

  await clickArtifactByName(window, basename(control))
  await expect(window.locator('.canvas-tab.active')).toContainText(basename(control))
  await clickArtifactByName(window, basename(target))
  const targetTab = window.locator('.canvas-tab').filter({ hasText: basename(target) })
  const controlTab = window.locator('.canvas-tab').filter({ hasText: basename(control) })
  await expect(targetTab).toHaveCount(1)
  await expect(controlTab).toHaveCount(1)
  await expect(targetTab).toHaveClass(/\bactive\b/)
  await window.getByTitle('Edit file', { exact: true }).click()
  const editor = window.locator('.cm-content:visible')
  await expect(editor).toHaveCount(1)
  await editor.click()
  await window.keyboard.press('ControlOrMeta+A')
  await window.keyboard.insertText(saved)
  await expect(editor).toContainText('saved by the owner')
  await expect(editor).toContainText('quantity = 7')
  await expect(targetTab.locator('.canvas-tab-dirty')).toBeVisible()
  expect(readFileSync(target, 'utf8')).toBe(initial)
  expect(readFileSync(control, 'utf8')).toBe(controlText)

  await window.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => readFileSync(target, 'utf8')).toBe(saved)
  await expect(targetTab.locator('.canvas-tab-dirty')).toHaveCount(0)
  await expect(window.getByTitle('Edit file', { exact: true })).toBeVisible()
  expect(readFileSync(control, 'utf8')).toBe(controlText)
  await targetTab.hover()
  await targetTab.locator('button.canvas-tab-close').click()
  await expect(targetTab).toHaveCount(0)
  await expect(controlTab).toHaveCount(1)
  await expect(window.locator('.cm-content:visible')).toContainText(controlText.trim())

  await clickArtifactByName(window, basename(target))
  await expect(window.locator('.canvas-tab.active')).toContainText(basename(target))
  await expect(window.locator('.cm-content:visible')).toContainText('saved by the owner')
  await expect(window.locator('.cm-content:visible')).toContainText('quantity = 7')
  await expect(targetTab.locator('.canvas-tab-dirty')).toHaveCount(0)
  expect(readFileSync(target, 'utf8')).toBe(saved)
  expect(readFileSync(control, 'utf8')).toBe(controlText)
  await info.attach('saved-file', { path: target, contentType: 'text/plain' })
  await info.attach('unchanged-control-file', { path: control, contentType: 'text/plain' })
})
