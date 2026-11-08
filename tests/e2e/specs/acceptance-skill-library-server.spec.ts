import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Locator, Page } from '@playwright/test'
import type { SkillCopy, SkillCopyInput, SkillImportInput, SkillInventory, SkillMoveInput, SkillSaveInput } from '../../../src/shared/types/skills'
import { test, expect, skillUpgradeAcceptance, type SkillServer } from '../fixtures/acceptance-skill-server'
import { ownedSkillFile, readSkillPackage, skillImport, skillMarkdown } from '../fixtures/acceptance-skills'
import { waitForHomePage } from '../fixtures/helpers'

test.describe.configure({ retries: 0 })
test.use({ useScriptedModel: false })
test.setTimeout(180000)

function card(page: Page, name: string): Locator {
  return page.locator('[role="button"]').filter({ has: page.getByRole('heading', { name, exact: true, level: 3 }) })
}

async function selectWorkspace(page: Page, spaceId: string | null = null) {
  const selector = page.getByRole('combobox', { name: 'Workspace', exact: true })
  await selector.selectOption(spaceId ?? '')
  await expect(selector).toHaveValue(spaceId ?? '')
  await expect(page.getByRole('button', { name: 'Refresh skills', exact: true })).toBeEnabled()
}

async function openLibrary(page: Page) {
  await page.locator('nav').getByRole('button', { name: 'Digital Humans', exact: true }).click()
  await page.getByRole('button', { name: 'Capability library', exact: true }).click()
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await selectWorkspace(page)
}

function onlyCopy(inventory: SkillInventory, name: string, spaceId: string | null = null): SkillCopy {
  const copies = inventory.groups.find(group => group.name === name)?.copies.filter(copy => copy.spaceId === spaceId) ?? []
  expect(copies, `Exactly one ${name} copy must exist in the selected scope`).toHaveLength(1)
  return copies[0]
}

async function legacyState(server: SkillServer) {
  const inventory = await server.list()
  const packages = server.records.filter(record => !['uninstalled', 'deleted'].includes(record.kind)).map(record => {
    const copy = onlyCopy(inventory, record.name)
    return { name: copy.name, path: copy.path, enabled: copy.enabled, package: readSkillPackage(server.profile, copy) }
  })
  return { rows: server.rows(), packages }
}

async function uploadZip(page: Page, file: string) {
  await page.getByRole('button', { name: 'Manual Add Skill', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add Skill', exact: true })
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(dialog.getByText('Import creates an independent copy. Changes to the source will not sync with this skill.', { exact: true })).toBeVisible()
  await dialog.locator('input[type="file"][accept=".md,.zip"]').setInputFiles(file)
  await expect(dialog.getByText(basename(file), { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Install Skill', exact: true })).toBeEnabled()
  return dialog
}

async function replaceInstructions(page: Page, content: string) {
  const editor = page.locator('.cm-content[contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.click()
  await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText(content)
}

async function openCardMoveMenu(page: Page, name: string) {
  const item = card(page, name)
  await item.hover()
  await item.getByRole('button', { name: 'More', exact: true }).click()
  await item.getByRole('button', { name: 'Move to workspace', exact: true }).click()
  return item
}

test('global skill creation retains a closed draft and card toggles survive restart without deleting files', skillUpgradeAcceptance('capabilities.skill-library-server.create'), async ({ skillServer: server }, info) => {
  let page = server.page
  const before = await legacyState(server)
  const name = 'library-draft-evidence'
  const description = 'Searchable drafting evidence'
  const body = 'Keep these instructions when closing the creation form.'
  const imports: SkillImportInput[] = []
  const deletions: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path === '/api/skills/import') imports.push(request.postDataJSON() as SkillImportInput)
    if (['/api/skills/delete', '/api/skills/delete-legacy'].includes(path)) deletions.push(path)
  })

  await test.step('Close a visual draft and reopen it without creating a skill', async () => {
    await openLibrary(page)
    await page.getByRole('button', { name: 'Manual Add Skill', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add Skill', exact: true })
    await expect(dialog.getByText('Global (all spaces)', { exact: true })).toBeVisible()
    await dialog.getByPlaceholder('e.g. Code Review Guidelines', { exact: true }).fill(name)
    await dialog.getByPlaceholder('When should the AI use this skill?', { exact: true }).fill(description)
    await dialog.getByPlaceholder('Write the skill instructions here in Markdown...', { exact: true }).fill(body)
    await dialog.getByRole('button', { name: 'Close and keep draft', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(imports).toHaveLength(0)
    expect((await server.list()).groups.some(group => group.name === name)).toBe(false)
    expect(existsSync(join(server.profile, '.agents/skills', name, 'SKILL.md'))).toBe(false)
    await page.getByRole('button', { name: 'Manual Add Skill', exact: true }).click()
    await expect(dialog.getByPlaceholder('e.g. Code Review Guidelines', { exact: true })).toHaveValue(name)
    await expect(dialog.getByPlaceholder('When should the AI use this skill?', { exact: true })).toHaveValue(description)
    await expect(dialog.getByPlaceholder('Write the skill instructions here in Markdown...', { exact: true })).toHaveValue(body)
    await dialog.getByRole('button', { name: 'Install Skill', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  await selectWorkspace(page)
  await page.getByRole('textbox', { name: 'Search skills', exact: true }).fill(description)
  await expect(card(page, name)).toBeVisible()
  await expect(card(page, server.records.find(record => record.kind === 'control')!.name)).toHaveCount(0)
  const installed = onlyCopy(await server.list(), name)
  expect(installed).toMatchObject({ source: 'personal', scope: 'global', enabled: true, availability: 'available' })
  expect(ownedSkillFile(server.profile, installed)).toBe(join(server.profile, '.agents/skills', name, 'SKILL.md'))
  const initial = await server.read({ id: installed.id, spaceId: null })
  expect(initial.content).toContain(`name: ${name}`)
  expect(initial.content).toContain(`description: ${description}`)
  expect(initial.content).toContain(body)
  expect(imports).toHaveLength(1)
  expect(imports[0]).toMatchObject({ spaceId: null, spec: { name } })

  await test.step('Disable directly from the card, then restart with the disabled choice intact', async () => {
    await card(page, name).hover()
    await card(page, name).getByRole('button', { name: 'Disable', exact: true }).click()
    await expect(card(page, name).getByRole('button', { name: 'Enable', exact: true })).toBeEnabled()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    expect(onlyCopy(await server.list(), name)).toMatchObject({ id: installed.id, enabled: false, availability: 'disabled' })
    page = await server.restart()
    await openLibrary(page)
    await expect(card(page, name).getByText('Disabled', { exact: true })).toBeVisible()
    const inventory = await server.list()
    expect(onlyCopy(inventory, name)).toMatchObject({ id: installed.id, enabled: false, availability: 'disabled' })
    expect(inventory.groups.find(group => group.name === name)?.effectiveId).toBeUndefined()
    expect(readFileSync(installed.path, 'utf8')).toBe(initial.content)
  })

  await test.step('Reenable, cancel card deletion and restart without touching the package or controls', async () => {
    await card(page, name).hover()
    await card(page, name).getByRole('button', { name: 'Enable', exact: true }).click()
    await expect(card(page, name).getByRole('button', { name: 'Disable', exact: true })).toBeEnabled()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await card(page, name).getByRole('button', { name: 'More', exact: true }).click()
    await card(page, name).getByRole('button', { name: 'Delete', exact: true }).click()
    const deletion = page.getByRole('alertdialog', { name: 'Delete this skill?', exact: true })
    await expect(deletion).toContainText(name)
    await expect(deletion).toContainText('This skill and its supporting files will move to the Trash.')
    await page.screenshot({ path: info.outputPath('skill-delete-before-cancel.png') })
    await deletion.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(deletion).toHaveCount(0)
    expect(deletions).toEqual([])
    expect(readFileSync(installed.path, 'utf8')).toBe(initial.content)
    page = await server.restart()
    await openLibrary(page)
    await expect(card(page, name).getByRole('button', { name: 'Disable', exact: true })).toBeEnabled()
    const inventory = await server.list()
    expect(onlyCopy(inventory, name)).toMatchObject({ id: installed.id, enabled: true, availability: 'available' })
    expect(inventory.groups.find(group => group.name === name)?.effectiveId).toBe(installed.id)
    await card(page, name).click()
    await expect(page.getByText(body, { exact: true })).toBeVisible()
    expect((await server.read({ id: installed.id, spaceId: null })).content).toBe(initial.content)
    expect(await legacyState(server)).toEqual(before)
    expect(deletions).toEqual([])
    await info.attach('skill-create-final-state', { body: JSON.stringify({ inventory, imports, trashRequests: deletions }, null, 2), contentType: 'application/json' })
  })
})

test('real ZIP upload makes an independent copy and explicit replacement preserves disabled state and binary bytes', skillUpgradeAcceptance('capabilities.skill-library-server.zip'), async ({ skillServer: server }, info) => {
  let page = server.page
  const before = await legacyState(server)
  const name = 'library-zip-evidence'
  const original = {
    content: skillMarkdown(name, 'Read the original uploaded package.'),
    reference: 'Original nested supporting text.\n',
    binary: Buffer.from([0, 255, 128, 13, 10, 0, 42]).toString('base64'),
  }
  const replacement = {
    content: skillMarkdown(name, 'Read the explicitly replaced package.'),
    reference: 'Replacement nested supporting text.\n',
    binary: Buffer.from([255, 0, 254, 128, 10, 13, 0, 99, 42]).toString('base64'),
  }
  const archive = (content: typeof original, obsolete = false) => {
    const files: Record<string, Uint8Array> = {
      'package/SKILL.md': strToU8(content.content),
      'package/references/nested/evidence.md': strToU8(content.reference),
      'package/templates/evidence.bin': Buffer.from(content.binary, 'base64'),
    }
    if (obsolete) files['package/scripts/obsolete.js'] = strToU8('export const obsolete = true\n')
    return zipSync(files)
  }
  const source = info.outputPath('client-skill.zip')
  const originalArchive = Buffer.from(archive(original, true))
  const replacementArchive = Buffer.from(archive(replacement))
  writeFileSync(source, originalArchive)
  await info.attach('original-client-skill.zip', { body: originalArchive, contentType: 'application/zip' })
  const imports: SkillImportInput[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/skills/import') imports.push(request.postDataJSON() as SkillImportInput)
  })

  await openLibrary(page)
  const dialog = await uploadZip(page, source)
  await expect(dialog.getByText(`4 files · /${name}`, { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Install Skill', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await selectWorkspace(page)
  await expect(card(page, name)).toBeVisible()
  const installed = onlyCopy(await server.list(), name)
  const packageRoot = dirname(ownedSkillFile(server.profile, installed))
  expect(readSkillPackage(server.profile, installed)).toEqual(original)
  expect(existsSync(join(packageRoot, 'scripts/obsolete.js'))).toBe(true)
  expect(readFileSync(source)).toEqual(originalArchive)
  expect(imports).toHaveLength(1)
  expect(imports[0].replace).toBeUndefined()

  await test.step('Change only the client archive and verify refresh does not synchronize the installed copy', async () => {
    writeFileSync(source, replacementArchive)
    await page.getByRole('button', { name: 'Refresh skills', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Refresh skills', exact: true })).toBeEnabled()
    expect(readSkillPackage(server.profile, installed)).toEqual(original)
    await card(page, name).hover()
    await card(page, name).getByRole('button', { name: 'Disable', exact: true }).click()
    await expect(card(page, name).getByRole('button', { name: 'Enable', exact: true })).toBeEnabled()
    expect(onlyCopy(await server.list(), name).enabled).toBe(false)
  })

  const disabled = await server.read({ id: installed.id, spaceId: null })
  await test.step('Cancel a same-name conflict before explicitly choosing Replace existing', async () => {
    const reimport = await uploadZip(page, source)
    await expect(reimport.getByText(`3 files · /${name}`, { exact: true })).toBeVisible()
    await reimport.getByRole('button', { name: 'Install Skill', exact: true }).click()
    const conflict = reimport.getByText('A skill with this name already exists in this scope. Nothing has been overwritten.', { exact: true })
    await expect(conflict).toBeVisible()
    await expect(reimport.getByRole('button', { name: 'Replace existing', exact: true })).toBeEnabled()
    await expect(reimport.getByRole('button', { name: 'Install Skill', exact: true })).toBeDisabled()
    expect(imports).toHaveLength(1)
    expect(readSkillPackage(server.profile, installed)).toEqual(original)
    await reimport.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(conflict).toHaveCount(0)
    expect(imports).toHaveLength(1)
    expect(readSkillPackage(server.profile, installed)).toEqual(original)
    expect(readFileSync(source)).toEqual(replacementArchive)
    await reimport.getByRole('button', { name: 'Install Skill', exact: true }).click()
    await expect(conflict).toBeVisible()
    await page.screenshot({ path: info.outputPath('skill-zip-before-replace.png') })
    await reimport.getByRole('button', { name: 'Replace existing', exact: true }).click()
    await expect(reimport).toHaveCount(0)
  })

  expect(imports).toHaveLength(2)
  expect(imports[1].replace).toEqual({ ref: { id: installed.id, spaceId: null }, revision: disabled.revision })
  const replaced = onlyCopy(await server.list(), name)
  expect(replaced).toMatchObject({ id: installed.id, enabled: false, availability: 'disabled' })
  expect(readSkillPackage(server.profile, replaced)).toEqual(replacement)
  expect(existsSync(join(packageRoot, 'scripts/obsolete.js'))).toBe(false)
  const detail = await server.read({ id: replaced.id, spaceId: null })
  expect(detail.files.map(file => file.path).sort()).toEqual(['SKILL.md', 'references/nested/evidence.md', 'templates/evidence.bin'])
  expect(detail.files.find(file => file.path === 'templates/evidence.bin')).toMatchObject({ binary: true, size: 9 })
  expect(readFileSync(source)).toEqual(replacementArchive)
  page = await server.restart()
  await openLibrary(page)
  await expect(card(page, name).getByText('Disabled', { exact: true })).toBeVisible()
  const inventory = await server.list()
  expect(onlyCopy(inventory, name)).toMatchObject({ id: installed.id, enabled: false, availability: 'disabled' })
  expect(inventory.groups.find(group => group.name === name)?.effectiveId).toBeUndefined()
  expect(readSkillPackage(server.profile, replaced)).toEqual(replacement)
  expect(existsSync(join(packageRoot, 'scripts/obsolete.js'))).toBe(false)
  await card(page, name).click()
  await expect(page.getByText('Read the explicitly replaced package.', { exact: true })).toBeVisible()
  expect(await legacyState(server)).toEqual(before)
  expect(readFileSync(source)).toEqual(replacementArchive)
  await info.attach('skill-zip-final-state', { body: JSON.stringify({ inventory, files: detail.files, imports }, null, 2), contentType: 'application/json' })
})

test('an unsaved custom copy moves through card and detail scope menus without overwriting originals or conflicts', skillUpgradeAcceptance('capabilities.skill-library-server.move-copy'), async ({ skillServer: server }, info) => {
  let page = server.page
  const before = await legacyState(server)
  const name = 'library-custom-copy-evidence'
  const occupiedPath = join(server.profile, 'tmp/occupied-skill-workspace')
  const emptyPath = join(server.profile, 'tmp/empty-skill-workspace')
  mkdirSync(occupiedPath)
  mkdirSync(emptyPath)
  const occupied = await server.request<{ id: string; name: string }>('/api/spaces', { name: 'Occupied skill workspace', icon: 'folder', customPath: occupiedPath })
  const target = await server.request<{ id: string; name: string }>('/api/spaces', { name: 'Empty skill workspace', icon: 'folder', customPath: emptyPath })
  const collision = await server.request<SkillCopy>('/api/skills/import', skillImport(occupied.id, name, 'Keep the pre-existing destination package.'))
  const collisionPackage = readSkillPackage(server.profile, collision)
  const sourceRecord = server.records.find(record => record.kind === 'active')!
  const original = onlyCopy(await server.list(), sourceRecord.name)
  const originalPackage = readSkillPackage(server.profile, original)
  const draftBody = 'These unsaved instructions belong only to the custom copy.'
  const draft = originalPackage.content.replace(sourceRecord.body, draftBody)
  const copies: SkillCopyInput[] = []
  const moves: SkillMoveInput[] = []
  const saves: SkillSaveInput[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path === '/api/skills/copy') copies.push(request.postDataJSON() as SkillCopyInput)
    if (path === '/api/skills/move') moves.push(request.postDataJSON() as SkillMoveInput)
    if (path === '/api/skills/save') saves.push(request.postDataJSON() as SkillSaveInput)
  })
  await page.reload()
  await waitForHomePage(page)
  await openLibrary(page)

  await test.step('Save a custom copy from an unsaved editor draft without saving the original', async () => {
    await card(page, sourceRecord.name).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await replaceInstructions(page, draft)
    await page.getByRole('button', { name: 'Save custom copy', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Save a custom skill copy', exact: true })
    await expect(dialog.getByText('The original stays unchanged. All supporting files are copied. The copies are independent and changes will not sync.', { exact: true })).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Command name', exact: true }).fill(name)
    await dialog.getByRole('combobox', { name: 'Destination', exact: true }).selectOption('')
    await dialog.getByRole('button', { name: 'Save custom copy', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByText(sourceRecord.body, { exact: true })).toBeVisible()
    expect(copies).toEqual([{ ref: { id: original.id, spaceId: null }, spaceId: null, name, content: draft }])
    expect(saves).toEqual([])
    expect(readSkillPackage(server.profile, original)).toEqual(originalPackage)
    await page.getByRole('button', { name: 'Back to capability library', exact: true }).click()
    await selectWorkspace(page)
  })

  const custom = onlyCopy(await server.list(), name)
  const customPackage = readSkillPackage(server.profile, custom)
  expect(customPackage.content).toContain(`name: ${name}`)
  expect(customPackage.content).toContain(draftBody)
  expect(customPackage.content).not.toContain(sourceRecord.body)
  expect(customPackage.content).toContain('x-acceptance-metadata: preserve-me')
  expect(customPackage.reference).toBe(originalPackage.reference)
  expect(customPackage.binary).toBe(originalPackage.binary)
  await card(page, name).hover()
  await card(page, name).getByRole('button', { name: 'Disable', exact: true }).click()
  await expect(card(page, name).getByRole('button', { name: 'Enable', exact: true })).toBeEnabled()

  await test.step('Dismiss the menu, cancel a move and refuse an occupied destination without mutation', async () => {
    const item = await openCardMoveMenu(page, name)
    await expect(item.getByRole('button', { name: 'Global (all spaces)', exact: true })).toBeVisible()
    await expect(item.getByRole('button', { name: occupied.name, exact: true })).toBeVisible()
    await expect(item.getByRole('button', { name: target.name, exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(item.getByRole('button', { name: 'More', exact: true })).toHaveAttribute('aria-expanded', 'false')
    expect(moves).toEqual([])
    await openCardMoveMenu(page, name)
    await item.getByRole('button', { name: target.name, exact: true }).click()
    const confirmation = page.getByRole('alertdialog', { name: 'Move this skill?', exact: true })
    await expect(confirmation).toContainText(target.name)
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    expect(moves).toEqual([])
    expect(readSkillPackage(server.profile, onlyCopy(await server.list(), name))).toEqual(customPackage)
    expect(existsSync(join(emptyPath, '.agents/skills', name, 'SKILL.md'))).toBe(false)
    await openCardMoveMenu(page, name)
    const preview = page.waitForResponse(response => new URL(response.url()).pathname === '/api/skills/move-preview' && response.request().postDataJSON().spaceId === occupied.id)
    await item.getByRole('button', { name: occupied.name, exact: true }).click()
    expect(await (await preview).json()).toMatchObject({ success: true, data: { conflict: 'The destination already contains a skill with this name.' } })
    await expect(item.getByRole('alert')).toBeVisible()
    await expect(item.getByRole('alert')).not.toBeEmpty()
    await expect(item.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled()
    await expect(confirmation).toHaveCount(0)
    expect(moves).toEqual([])
    expect(readSkillPackage(server.profile, custom)).toEqual(customPackage)
    expect(readSkillPackage(server.profile, collision)).toEqual(collisionPackage)
  })

  await test.step('Move the disabled complete copy into a workspace, then back through the detail scope menu', async () => {
    const item = await openCardMoveMenu(page, name)
    await item.getByRole('button', { name: target.name, exact: true }).click()
    const confirmation = page.getByRole('alertdialog', { name: 'Move this skill?', exact: true })
    await expect(confirmation).toContainText('This moves the skill and its supporting files.')
    await confirmation.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect(card(page, name)).toHaveCount(0)
    expect(existsSync(custom.path)).toBe(false)
    const workspaceInventory = await server.request<SkillInventory>('/api/skills/list', { spaceId: target.id, limit: 100 })
    const moved = onlyCopy(workspaceInventory, name, target.id)
    expect(moved).toMatchObject({ scope: 'space', spaceId: target.id, enabled: false, availability: 'disabled' })
    expect(ownedSkillFile(server.profile, moved)).toBe(join(emptyPath, '.agents/skills', name, 'SKILL.md'))
    expect(readSkillPackage(server.profile, moved)).toEqual(customPackage)
    await selectWorkspace(page, target.id)
    await expect(card(page, name).getByText('Disabled', { exact: true })).toBeVisible()
    await expect(card(page, name).getByText(target.name, { exact: true })).toBeVisible()
    await card(page, name).click()
    await expect(page.getByText(draftBody, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Change workspace', exact: true }).click()
    await page.getByRole('button', { name: 'Global (all spaces)', exact: true }).click()
    await expect(confirmation).toContainText('Global (all spaces)')
    await confirmation.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await selectWorkspace(page)
    await expect(card(page, name).getByText('Disabled', { exact: true })).toBeVisible()
    expect(existsSync(moved.path)).toBe(false)
    expect(readSkillPackage(server.profile, onlyCopy(await server.list(), name))).toEqual(customPackage)
    expect(moves.map(move => move.spaceId)).toEqual([target.id, null])
  })

  page = await server.restart()
  await openLibrary(page)
  await expect(card(page, name).getByText('Disabled', { exact: true })).toBeVisible()
  const inventory = await server.list()
  const returned = onlyCopy(inventory, name)
  expect(returned).toMatchObject({ scope: 'global', spaceId: null, enabled: false, availability: 'disabled' })
  expect(inventory.groups.find(group => group.name === name)?.effectiveId).toBeUndefined()
  expect(readSkillPackage(server.profile, returned)).toEqual(customPackage)
  expect(existsSync(join(emptyPath, '.agents/skills', name, 'SKILL.md'))).toBe(false)
  const occupiedInventory = await server.request<SkillInventory>('/api/skills/list', { spaceId: occupied.id, limit: 100 })
  expect(readSkillPackage(server.profile, onlyCopy(occupiedInventory, name, occupied.id))).toEqual(collisionPackage)
  expect(readSkillPackage(server.profile, original)).toEqual(originalPackage)
  expect(await legacyState(server)).toEqual(before)
  expect(saves).toEqual([])
  await card(page, name).click()
  await expect(page.getByText(draftBody, { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('skill-custom-copy-after-restart.png') })
  await info.attach('skill-copy-move-final-state', { body: JSON.stringify({ inventory, occupiedInventory, copies, moves, saves }, null, 2), contentType: 'application/json' })
})
