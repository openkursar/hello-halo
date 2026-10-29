import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { basename } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { ContentReference } from '../../../src/shared/types/content-reference'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { createReferenceDiffRepository } from '../fixtures/acceptance-reference-diff'
import { openManagedConversation, seedManagedSpace, workspaceCard } from '../fixtures/acceptance-management'
import {
  ADD_TO_CHAT_KEY, chooseScope, commentCard, commentOnWord, composerPill, diffCard,
  doubleClickWord, ensureFilePanel, filePanel, openChangesWithShortcut, selectionBar,
} from '../fixtures/changes-helpers'
import { navigateToWorkspaces } from '../fixtures/helpers'
import { clickArtifactByName } from '../../perf/lib/open-artifact'

test.setTimeout(120000)

async function readConversation(page: Page, spaceId: string, conversationId: string) {
  return page.evaluate(async ({ spaceId, conversationId }) => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.getConversation(spaceId, conversationId)
    if (!result.success || !result.data) throw new Error('The diff references must be readable from the actual conversation')
    return result.data as { title: string; messages: Array<{ id: string; role: string; content: string; metadata?: { references?: ContentReference[] } }> }
  }, { spaceId, conversationId })
}

test('both sides of a Git change and a separate file reach the model with their own excerpts and locations', acceptance('references.context.send', { source: 'diff' }), async ({ acceptanceApp, model, window }, info) => {
  const repository = createReferenceDiffRepository(acceptanceApp.profile)
  expect(repository.git('show', 'HEAD:revision.ts')).toBe(repository.original.trim())
  expect(repository.git('diff', '--name-only')).toBe('revision.ts')
  const space = await seedManagedSpace(window, 'Reference comparison workspace', repository.root)
  await acceptanceApp.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window.isMaximized()) window.unmaximize()
    window.setSize(1600, 1000)
  })
  await navigateToWorkspaces(window)
  const workspace = workspaceCard(window, space.name)
  await expect(workspace).toHaveCount(1)
  await workspace.click()
  await expect(window.getByTitle(`Current workspace: ${space.name} — click to switch`, { exact: true })).toBeVisible()
  await expect(window.locator('textarea')).toBeVisible()
  await window.getByRole('button', { name: 'New', exact: true }).click()
  await expect(window.locator('.message-user')).toHaveCount(0)
  const note = `Explain the revised identifier ${randomUUID()}`
  const question = `Compare the selected before and after with the companion declaration ${randomUUID()}`
  const answer = 'The selected diff sides and companion passage arrived.'
  const submitted: string[] = []
  model.respond(request => {
    submitted.push(request.lastUserText)
    return { text: answer }
  })

  await openChangesWithShortcut(window)
  await chooseScope(window, 'Uncommitted changes')
  await ensureFilePanel(window)
  await filePanel(window).locator('button[title="revision.ts"]').click()
  const card = diffCard(window, 'revision.ts')
  const split = window.getByRole('button', { name: 'Side by side', exact: true })
  await expect(split).toBeEnabled()
  if (await split.getAttribute('aria-pressed') !== 'true') await split.click()
  const beforeLine = card.locator('.cm-merge-a .cm-line').filter({ hasText: repository.before })
  await expect(beforeLine).toHaveCount(1)
  await doubleClickWord(window, beforeLine, repository.before)
  await expect(selectionBar(window)).toBeVisible()
  await window.keyboard.press(ADD_TO_CHAT_KEY)
  await expect(composerPill(window, 'selections')).toHaveText(/^1 selections?$/)

  const afterLine = card.locator('.cm-merge-b .cm-line').filter({ hasText: repository.after })
  await expect(afterLine).toHaveCount(1)
  await commentOnWord(window, afterLine, repository.after, note)
  await expect(commentCard(window, 'Comment · line 3 · After')).toContainText(note)
  await expect(composerPill(window, 'comments')).toHaveText(/^1 comments?$/)

  await clickArtifactByName(window, basename(repository.companionPath))
  await expect(window.locator('.canvas-tab.active')).toContainText(basename(repository.companionPath))
  const companionLine = window.locator('.cm-editor .cm-line').filter({ hasText: repository.companion })
  await expect(companionLine).toHaveCount(1)
  await doubleClickWord(window, companionLine, repository.companion)
  await expect(selectionBar(window)).toBeVisible()
  await window.keyboard.press(ADD_TO_CHAT_KEY)
  await expect(composerPill(window, 'selections')).toHaveText(/^2 selections?$/)
  await expect(composerPill(window, 'comments')).toHaveText(/^1 comments?$/)

  const turn = await sendAcceptanceMessage(window, question)
  expect(turn.spaceId).toBe(space.id)
  await expect(window.locator('.message-assistant').last()).toContainText(answer)
  await waitForAcceptanceIdle(window, turn.conversationId)
  const saved = await readConversation(window, turn.spaceId, turn.conversationId)
  const users = saved.messages.filter(message => message.role === 'user')
  expect(users).toHaveLength(1)
  expect(users[0].content).toBe(question)
  const references = users[0].metadata?.references
  expect(references).toHaveLength(3)
  expect(new Set(references!.map(reference => reference.id)).size).toBe(3)
  expect(references).toEqual([
    expect.objectContaining({ source: expect.objectContaining({ kind: 'diff', side: 'before', compareLabel: 'Uncommitted changes', repo: expect.objectContaining({ beforeRevision: repository.revision }) }), range: { startLine: 2, endLine: 2 }, quote: repository.before }),
    expect.objectContaining({ source: expect.objectContaining({ kind: 'diff', side: 'after', compareLabel: 'Uncommitted changes', repo: expect.objectContaining({ beforeRevision: repository.revision }) }), range: { startLine: 3, endLine: 3 }, quote: repository.after, note }),
    expect.objectContaining({ source: expect.objectContaining({ kind: 'file', precision: 'lines' }), range: { startLine: 4, endLine: 4 }, quote: repository.companion }),
  ])
  for (const reference of references!.slice(0, 2)) {
    if (reference.source.kind !== 'diff' || !reference.source.repo) throw new Error('A Git selection must retain its diff side and repository')
    expect(realpathSync(reference.source.path)).toBe(realpathSync(repository.revisedPath))
    expect(realpathSync(reference.source.repo.root)).toBe(realpathSync(repository.root))
  }
  const companionSource = references![2].source
  if (companionSource.kind !== 'file') throw new Error('The companion selection must retain its file location')
  expect(realpathSync(companionSource.path)).toBe(realpathSync(repository.companionPath))
  expect(references![0].note).toBeUndefined()
  expect(references![2].note).toBeUndefined()
  await expect(composerPill(window, 'selections')).toHaveCount(0)
  await expect(composerPill(window, 'comments')).toHaveCount(0)
  const sent = window.locator(`[data-message-id="${users[0].id}"]`).first()
  await expect(sent.getByRole('button', { name: /^2 selections?$/ })).toBeVisible()
  await expect(sent.getByRole('button', { name: /^1 comments?$/ })).toBeVisible()

  await info.attach('submitted-diff-reference-observations', { body: JSON.stringify({ references, submitted }, null, 2), contentType: 'application/json' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain(question)
  const blocks = [...submitted[0].matchAll(/<halo_references>\n([\s\S]*?)\n<\/halo_references>/g)]
  expect(blocks).toHaveLength(1)
  const context = blocks[0][1]
  const starts = [...context.matchAll(/^\[(\d+)\] /gm)]
  expect(starts.map(match => Number(match[1]))).toEqual([1, 2, 3])
  const entries = starts.map((match, index) => context.slice(match.index, starts[index + 1]?.index ?? context.length).trim())
  expect(entries[0].split('\n')[0]).toBe(`[1] Diff "Uncommitted changes" of revision.ts, before side, line 2 (before revision ${repository.revision})`)
  expect(entries[1].split('\n')[0]).toBe(`[2] Diff "Uncommitted changes" of revision.ts, after side, line 3 (before revision ${repository.revision})`)
  expect(entries[2].split('\n')[0]).toBe('[3] companion.ts, line 4')
  for (const [index, quote] of [repository.before, repository.after, repository.companion].entries()) {
    expect(entries[index]).toContain(`Excerpt:\n\`\`\`ts\n${quote}\n\`\`\``)
    expect(context.split(quote)).toHaveLength(2)
  }
  expect(entries[1]).toContain(`Note: ${note}`)
  expect(context.split(note)).toHaveLength(2)
  expect(context).not.toContain(repository.unrelated)
  expect(context).not.toContain('export const')
  expect(repository.git('rev-parse', 'HEAD')).toBe(repository.revision)
  for (const [file, content] of repository.files) expect(readFileSync(file, 'utf8')).toBe(content)

  const reopened = await acceptanceApp.restart()
  await openManagedConversation(reopened, saved.title, space.id)
  const restored = await readConversation(reopened, turn.spaceId, turn.conversationId)
  expect(restored.messages.filter(message => message.role === 'user')).toEqual(users)
  expect(model.exchanges).toHaveLength(1)
  expect(repository.git('rev-parse', 'HEAD')).toBe(repository.revision)
  for (const [file, content] of repository.files) expect(readFileSync(file, 'utf8')).toBe(content)
})
