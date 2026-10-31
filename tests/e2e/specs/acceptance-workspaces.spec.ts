import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import {
  test, expect, managementAcceptance, createWorkspaceThroughUi, listManagedSpaces,
  openWorkspaceMenu, seedManagedConversation, seedManagedSpace, workspaceCard,
} from '../fixtures/acceptance-management'
import { navigateToWorkspaces } from '../fixtures/helpers'

test.setTimeout(90000)

test('workspace names, colors and keyboard order survive restart without moving project files', managementAcceptance('workspaces.retention.rename'), async ({ managementApp, window }) => {
  const first = await createWorkspaceThroughUi(window, 'Research archive')
  const second = await createWorkspaceThroughUi(window, 'Release archive')
  const note = join(first.path, 'retained-note.txt')
  writeFileSync(note, 'Workspace identity changes must keep this file.\n')
  await navigateToWorkspaces(window)

  await openWorkspaceMenu(window, first.name, 'Edit')
  const editor = window.locator('.fixed.inset-0').filter({ has: window.getByRole('heading', { name: 'Edit Workspace', exact: true }) })
  await editor.getByPlaceholder('e.g. Payment Refactor', { exact: true }).fill('Discard this workspace name')
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await listManagedSpaces(window)).find(space => space.id === first.id)?.name).toBe(first.name)

  await openWorkspaceMenu(window, first.name, 'Edit')
  await editor.getByPlaceholder('e.g. Payment Refactor', { exact: true }).fill('Research evidence')
  await editor.getByRole('radiogroup', { name: 'Icon Color', exact: true }).getByRole('radio', { name: 'success', exact: true }).click()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect.poll(async () => (await listManagedSpaces(window)).find(space => space.id === first.id)).toMatchObject({ name: 'Research evidence', color: 'success', path: first.path })

  const sortable = window.locator('[aria-roledescription="sortable"]')
  await expect(sortable.locator('h3')).toHaveText([second.name, 'Research evidence'])
  const moving = sortable.filter({ has: window.getByRole('heading', { name: second.name, exact: true }) })
  const destination = sortable.filter({ has: window.getByRole('heading', { name: 'Research evidence', exact: true }) })
  const originBounds = await moving.boundingBox()
  const destinationBounds = await destination.boundingBox()
  if (!originBounds || !destinationBounds) throw new Error('Both reorderable workspaces must be visible')
  const direction = destinationBounds.y > originBounds.y + originBounds.height / 2 ? 'ArrowDown' : 'ArrowRight'
  const live = window.locator('[id^="DndLiveRegion"]')
  await expect(live).toHaveCount(1)
  await moving.focus()
  await window.keyboard.press('Space')
  await expect(moving).toHaveAttribute('aria-pressed', 'true')
  await expect(live).toContainText(`was moved over droppable area ${second.id}`)
  await window.keyboard.press(direction)
  await expect(live).toContainText(`was moved over droppable area ${first.id}`)
  await window.keyboard.press('Space')
  await expect.poll(() => moving.getAttribute('aria-pressed')).toBeNull()
  await expect(live).toContainText(`was dropped over droppable area ${first.id}`)
  await expect.poll(async () => (await listManagedSpaces(window)).map(space => space.id)).toEqual([first.id, second.id])

  const reopened = await managementApp.restart()
  await navigateToWorkspaces(reopened)
  await expect(reopened.locator('[aria-roledescription="sortable"] h3')).toHaveText(['Research evidence', second.name])
  expect((await listManagedSpaces(reopened)).find(space => space.id === first.id)).toMatchObject({ name: 'Research evidence', color: 'success', path: first.path })
  expect(readFileSync(note, 'utf8')).toBe('Workspace identity changes must keep this file.\n')
})

for (const kind of ['central', 'project'] as const) {
  test(`workspace deletion preserves the stated file boundary for ${kind} storage`, managementAcceptance('workspaces.retention.remove', { kind }), async ({ managementApp, window }) => {
    const project = join(managementApp.profile, 'external-project')
    mkdirSync(project, { recursive: true })
    const space = await seedManagedSpace(window, `Delete ${kind} workspace`, kind === 'project' ? project : undefined)
    const control = await seedManagedSpace(window, 'Unrelated workspace')
    const contents = 'A deletion must follow the displayed file boundary.\n'
    const file = join(space.workingDir ?? space.path, 'project-file.txt')
    const controlFile = join(control.path, 'control-file.txt')
    writeFileSync(file, contents)
    writeFileSync(controlFile, 'Unrelated work stays.\n')
    const conversation = await seedManagedConversation(window, space.id, 'Workspace deletion history', [
      { role: 'user', content: 'Retain the project files when removing its Halo records.' },
      { role: 'assistant', content: 'This is an isolated stored history fixture.' },
    ])
    await navigateToWorkspaces(window)
    await openWorkspaceMenu(window, space.name, 'Delete')
    const confirmation = window.getByRole('alertdialog', { name: 'Delete this workspace?', exact: true })
    await expect(confirmation).toContainText(kind === 'project' ? 'your project files will be kept' : 'All conversations and files in the workspace will be deleted')
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await listManagedSpaces(window)).some(item => item.id === space.id)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(contents)

    await openWorkspaceMenu(window, space.name, 'Delete')
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(workspaceCard(window, space.name)).toHaveCount(0)
    await expect.poll(async () => (await listManagedSpaces(window)).some(item => item.id === space.id)).toBe(false)
    await expect.poll(() => existsSync(space.path)).toBe(false)
    expect(existsSync(file)).toBe(kind === 'project')
    if (kind === 'project') expect(readFileSync(file, 'utf8')).toBe(contents)
    expect(readFileSync(controlFile, 'utf8')).toBe('Unrelated work stays.\n')
    const deleted = await window.evaluate(async ({ spaceId, id }) => (window as unknown as { halo: HaloAPI }).halo.getConversation(spaceId, id), { spaceId: space.id, id: conversation.id })
    expect(deleted.success).toBe(false)

    const reopened = await managementApp.restart()
    await navigateToWorkspaces(reopened)
    await expect(workspaceCard(reopened, space.name)).toHaveCount(0)
    await expect(workspaceCard(reopened, control.name)).toBeVisible()
    expect(existsSync(file)).toBe(kind === 'project')
    expect(readFileSync(controlFile, 'utf8')).toBe('Unrelated work stays.\n')
  })
}

test('forgetting an unavailable workspace leaves its files intact and does not restore the entry later', managementAcceptance('workspaces.retention.forget'), async ({ managementApp, window }) => {
  const space = await createWorkspaceThroughUi(window, 'Disconnected workspace')
  writeFileSync(join(space.path, 'retained-file.txt'), 'Retain the unavailable workspace data.\n')
  const offline = `${space.path}.disconnected`
  await navigateToWorkspaces(window)
  renameSync(space.path, offline)
  await window.getByTitle('Refresh', { exact: true }).click()
  await expect(workspaceCard(window, space.name).getByLabel('Unavailable', { exact: true })).toBeVisible()

  await openWorkspaceMenu(window, space.name, 'Remove from list')
  const confirmation = window.getByRole('alertdialog', { name: 'Remove this workspace from the list?', exact: true })
  await expect(confirmation).toContainText('Its files stay wherever they are')
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await listManagedSpaces(window)).some(item => item.id === space.id)).toBe(true)

  await openWorkspaceMenu(window, space.name, 'Remove from list')
  await confirmation.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(workspaceCard(window, space.name)).toHaveCount(0)
  expect(readFileSync(join(offline, 'retained-file.txt'), 'utf8')).toBe('Retain the unavailable workspace data.\n')
  renameSync(offline, space.path)
  const reopened = await managementApp.restart()
  await navigateToWorkspaces(reopened)
  await expect(workspaceCard(reopened, space.name)).toHaveCount(0)
  expect((await listManagedSpaces(reopened)).some(item => item.id === space.id)).toBe(false)
  expect(readFileSync(join(space.path, 'retained-file.txt'), 'utf8')).toBe('Retain the unavailable workspace data.\n')
})

test('workspace search filters by name without removing the other project records', managementAcceptance('workspaces.manage.search'), async ({ window }) => {
  const research = await seedManagedSpace(window, 'Research notes')
  const release = await seedManagedSpace(window, 'Release notes')
  await navigateToWorkspaces(window)
  const search = window.getByPlaceholder('Search workspaces', { exact: true })
  await search.fill('  RESEARCH  ')
  await expect(workspaceCard(window, research.name)).toBeVisible()
  await expect(workspaceCard(window, release.name)).toHaveCount(0)
  await search.fill('No matching workspace exists')
  await expect(window.getByText('No matching results found', { exact: true })).toBeVisible()
  await search.fill('')
  await expect(workspaceCard(window, research.name)).toBeVisible()
  await expect(workspaceCard(window, release.name)).toBeVisible()
  expect((await listManagedSpaces(window)).map(space => space.id).sort()).toEqual([research.id, release.id].sort())
})
