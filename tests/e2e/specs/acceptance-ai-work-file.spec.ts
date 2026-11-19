import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import { scriptedTurn, tabTitled } from '../fixtures/acceptance-ai-work'
import { navigateToChat } from '../fixtures/helpers'
import { openWorkspaceRail } from '../../perf/lib/open-artifact'
import { damagedPreviewDocument } from '../fixtures/acceptance-preview-recovery'
import { MAX_OPEN_TABS } from '../../../src/shared/constants/canvas-budget'

test('a report shown at the file tab limit is visible and stays within the tab budget', acceptance('files.ai-work.show-file-at-limit'), async ({ acceptanceApp, window, model }) => {
  test.setTimeout(180000)
  const directory = join(acceptanceApp.profile, '.halo', 'temp', 'artifacts')
  mkdirSync(directory, { recursive: true })
  const names = Array.from({ length: MAX_OPEN_TABS }, (_, index) => `reference-${String(index).padStart(2, '0')}.txt`)
  const folders = Array.from({ length: Math.ceil(names.length / 5) }, (_, index) => ({
    name: `References ${index + 1}`,
    files: names.slice(index * 5, (index + 1) * 5),
  }))
  for (const folder of folders) {
    const path = join(directory, folder.name)
    mkdirSync(path)
    for (const name of folder.files) writeFileSync(join(path, name), `Reference: ${name}\n`)
  }
  const deliverable = join(directory, 'delivery-report.md')
  const heading = 'The report that belongs in front of me'
  writeFileSync(deliverable, `# ${heading}\n`)
  await navigateToChat(window)
  await openWorkspaceRail(window)
  const tree = window.getByRole('tree')
  const fileRow = (name: string) => tree.getByRole('treeitem', { name, exact: true }).getByText(name, { exact: true })
  for (const folder of folders) {
    await fileRow(folder.name).click()
    for (const name of folder.files) {
      await fileRow(name).click()
      await expect(tabTitled(window, name)).toHaveClass(/\bactive\b/)
    }
    await fileRow(folder.name).click()
  }
  await expect(window.locator('.canvas-tab')).toHaveCount(MAX_OPEN_TABS)
  const result = await scriptedTurn(window, model, 'Please show the delivery report.', [
    { name: 'canvas_show', input: { target: 'file', path: deliverable } },
  ])
  expect(result.results[0]).toMatch(/^Shown: the user now sees the file/)
  await expect(tabTitled(window, 'delivery-report.md')).toHaveClass(/\bactive\b/)
  await expect(window.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  await expect(window.locator('.canvas-tab')).toHaveCount(MAX_OPEN_TABS)
  await expect(tabTitled(window, names[0])).toHaveCount(0)
})

test('showing a file distinguishes a Word error from the rendered report', acceptance('files.ai-work.show-document'), async ({ acceptanceApp, window, model }) => {
  const directory = join(acceptanceApp.profile, '.halo', 'temp', 'artifacts')
  mkdirSync(directory, { recursive: true })
  const marker = 'The readable Word report'
  const { valid, damaged } = await damagedPreviewDocument(marker)
  for (const file of [valid, damaged]) writeFileSync(join(directory, file.name), file.bytes)
  await navigateToChat(window)

  const failed = await scriptedTurn(window, model, 'Show the damaged Word file.', [
    { name: 'canvas_show', input: { target: 'file', path: join(directory, damaged.name) } },
  ])
  expect(failed.results[0]).toMatch(/^Opened .*but could not confirm the content was visible\./)
  await expect(window.getByText('Unable to preview this document', { exact: true })).toBeVisible()

  const shown = await scriptedTurn(window, model, 'Show the readable Word file.', [
    { name: 'canvas_show', input: { target: 'file', path: join(directory, valid.name) } },
  ])
  expect(shown.results[0]).toMatch(/^Shown: the user now sees the file/)
  await expect(tabTitled(window, valid.name)).toHaveClass(/\bactive\b/)
  await expect(window.locator('.docx-wrapper').getByText(marker, { exact: true })).toBeVisible()
})
