import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle, readAcceptanceConversation } from '../fixtures/acceptance-app'
import { modelTool, type AcceptanceModel } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'
import { clickArtifactByName } from '../../perf/lib/open-artifact'

const createRequest = 'Create the review note in the workspace.'
const reviseRequest = 'Revise the review note on disk.'

function scriptFileWork(model: AcceptanceModel, file: string, initial: string, revised: string) {
  model.respond(request => {
    const result = (id: string) => request.toolResults.find(result => result.id === id)
    if (request.lastUserText.includes(createRequest)) {
      if (!result('write-review-note')) return { tools: [modelTool(request, 'Write', { file_path: file, content: initial }, 'write-review-note')] }
      expect(result('write-review-note')!.error).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe(initial)
      return { text: 'The review note is ready.' }
    }
    if (request.lastUserText.includes(reviseRequest)) {
      if (!result('read-review-note')) return { tools: [modelTool(request, 'Read', { file_path: file }, 'read-review-note')] }
      expect(result('read-review-note')!.error).toBe(false)
      for (const line of initial.trim().split('\n').filter(Boolean)) expect(result('read-review-note')!.text).toContain(line)
      if (!result('edit-review-note')) return { tools: [modelTool(request, 'Edit', { file_path: file, old_string: initial, new_string: revised }, 'edit-review-note')] }
      expect(result('edit-review-note')!.error).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe(revised)
      return { text: 'The review note was revised on disk.' }
    }
    throw new Error(`Unexpected file-work request ${request.sequence}`)
  })
}

test('a file created and revised by real tools opens in the canvas, refreshes and survives restart', acceptance('files.preview.tool-preview'), async ({ acceptanceApp, model, window }, testInfo) => {
  test.setTimeout(120000)
  const file = join(acceptanceApp.profile, '.halo', 'temp', 'artifacts', 'review-note.md')
  const initial = '# Review note\n\nStatus: Draft\n'
  const revised = '# Review note\n\nStatus: Reviewed\n'
  expect(existsSync(file)).toBe(false)
  scriptFileWork(model, file, initial, revised)
  await navigateToChat(window)
  const first = await sendAcceptanceMessage(window, createRequest)
  await expect(window.locator('.message-assistant').last()).toContainText('The review note is ready.')
  await waitForAcceptanceIdle(window, first.conversationId)
  expect(readFileSync(file, 'utf8')).toBe(initial)
  await clickArtifactByName(window, basename(file))
  await expect(window.locator('.canvas-tab.active')).toContainText(basename(file))
  await expect(window.getByRole('heading', { name: 'Review note', exact: true })).toBeVisible()
  await expect(window.getByText('Status: Draft', { exact: true })).toBeVisible()
  const second = await sendAcceptanceMessage(window, reviseRequest)
  expect(second.conversationId).toBe(first.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText('The review note was revised on disk.')
  await waitForAcceptanceIdle(window, second.conversationId)
  await expect(window.getByText('Status: Reviewed', { exact: true })).toBeVisible()
  await expect(window.getByText('Status: Draft', { exact: true })).toHaveCount(0)
  expect(readFileSync(file, 'utf8')).toBe(revised)
  const history = await readAcceptanceConversation(window, first.spaceId, first.conversationId)
  await testInfo.attach('tool-produced-file', { path: file, contentType: 'text/markdown' })

  const reopened = await acceptanceApp.restart()
  await navigateToChat(reopened)
  await reopened.getByText(history.title, { exact: true }).first().click()
  await expect(reopened.locator('.message-assistant').last()).toContainText('The review note was revised on disk.')
  await clickArtifactByName(reopened, basename(file))
  await expect(reopened.getByRole('heading', { name: 'Review note', exact: true })).toBeVisible()
  await expect(reopened.getByText('Status: Reviewed', { exact: true })).toBeVisible()
  expect(readFileSync(file, 'utf8')).toBe(revised)
})

for (const resolution of ['disk', 'local'] as const) {
  test(`unsaved canvas edits survive a real tool edit until the user chooses ${resolution}`, acceptance('files.edit.unsaved-conflict', { resolution }), async ({ acceptanceApp, model, window }, testInfo) => {
    test.setTimeout(120000)
    const file = join(acceptanceApp.profile, '.halo', 'temp', 'artifacts', 'review-note.ts')
    const initial = 'export const decision = "draft"\n'
    const revised = 'export const decision = "reviewed by AI"\n'
    const local = 'export const decision = "my unsaved choice"\n'
    expect(existsSync(file)).toBe(false)
    scriptFileWork(model, file, initial, revised)
    await navigateToChat(window)
    const first = await sendAcceptanceMessage(window, createRequest)
    await expect(window.locator('.message-assistant').last()).toContainText('The review note is ready.')
    await waitForAcceptanceIdle(window, first.conversationId)
    await clickArtifactByName(window, basename(file))
    const tab = window.locator('.canvas-tab.active')
    await expect(tab).toContainText(basename(file))
    await window.getByTitle('Edit file', { exact: true }).click()
    const editor = window.locator('.cm-content').first()
    await editor.click()
    await window.keyboard.press('ControlOrMeta+A')
    await window.keyboard.insertText(local)
    await expect(editor).toContainText('my unsaved choice')
    await expect(tab.locator('.canvas-tab-dirty')).toBeVisible()
    expect(readFileSync(file, 'utf8')).toBe(initial)

    const update = await sendAcceptanceMessage(window, reviseRequest)
    await expect(window.locator('.message-assistant').last()).toContainText('The review note was revised on disk.')
    await waitForAcceptanceIdle(window, update.conversationId)
    expect(readFileSync(file, 'utf8')).toBe(revised)
    await expect(editor).toContainText('my unsaved choice')
    await expect(window.getByRole('alert').filter({ hasText: 'This file changed on disk while you were editing it.' })).toBeVisible()
    if (resolution === 'disk') {
      await window.getByRole('button', { name: 'Load disk version', exact: true }).click()
      await expect(editor).toContainText('reviewed by AI')
      await expect(editor).not.toContainText('my unsaved choice')
    } else {
      await window.getByRole('button', { name: 'Keep my edits', exact: true }).click()
      await expect(editor).toContainText('my unsaved choice')
      await window.getByRole('button', { name: 'Save', exact: true }).click()
    }
    await expect(window.getByText('This file changed on disk while you were editing it.', { exact: true })).toHaveCount(0)
    await expect(tab.locator('.canvas-tab-dirty')).toHaveCount(0)
    const expected = resolution === 'disk' ? revised : local
    await expect.poll(() => readFileSync(file, 'utf8')).toBe(expected)
    await testInfo.attach('resolved-file', { path: file, contentType: 'text/plain' })

    const reopened = await acceptanceApp.restart()
    await navigateToChat(reopened)
    await clickArtifactByName(reopened, basename(file))
    await expect(reopened.locator('.cm-content').first()).toContainText(expected.trim())
    expect(readFileSync(file, 'utf8')).toBe(expected)
  })
}
