import { existsSync } from 'node:fs'
import type { HaloAPI } from '../../../src/preload'
import type { Page } from '@playwright/test'
import { test, expect, managementAcceptance, openManagedPersonSettings, seedManagedPerson, seedManagedSpace } from '../fixtures/acceptance-management'
import { ownedSkillFile, readSkillPackage, requireSkillData, skillImport, skillRef, skillRequest } from '../fixtures/acceptance-skills'
import { navigateToApps } from '../fixtures/helpers'
import type { SkillCopy } from '../../../src/shared/types/skills'

test.setTimeout(90000)

async function openSkill(page: Page, copy: SkillCopy, context = copy.spaceId ?? 'halo-temp') {
  await navigateToApps(page)
  const back = page.getByRole('button', { name: 'Back to capability library', exact: true })
  if (await back.isVisible()) await back.click()
  const library = page.getByRole('button', { name: 'Capability library', exact: true })
  if (await library.isVisible()) await library.click()
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(context)
  await page.getByRole('textbox', { name: 'Search skills', exact: true }).fill(copy.name)
  const card = page.locator('[role="button"]').filter({ has: page.getByRole('heading', { name: copy.displayName, level: 3, exact: true }) })
  await expect(card).toHaveCount(1)
  await card.click()
  const scope = page.getByRole('button', { name: 'Change workspace', exact: true })
  await expect(scope).toBeEnabled()
  const inventory = requireSkillData(await skillRequest(page, 'skillsList', { spaceId: context, q: copy.name }))
  const group = inventory.groups.find(group => group.name === copy.name)!
  if ((group.effectiveId ?? group.copies[0].id) !== copy.id) {
    const versions = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Other versions$/ }) })
    await expect(versions).not.toHaveAttribute('open')
    await versions.locator('summary').click()
    const workspace = copy.spaceId === null ? 'Global (all spaces)' : await page.evaluate(async id => {
      const result = await (window as unknown as { halo: HaloAPI }).halo.getSpace(id)
      if (!result.success || !result.data) throw new Error('The selected skill workspace must exist')
      return (result.data as { name: string }).name
    }, copy.spaceId)
    const version = versions.getByRole('button').filter({ hasText: `${workspace} · ` })
    await expect(version).toHaveCount(1)
    await version.click()
    await expect(version).toBeDisabled()
    await expect(scope).toContainText(workspace)
    await expect(scope).toBeEnabled()
  }
  await expect(page.getByRole('heading', { name: copy.displayName, level: 2, exact: true })).toBeVisible()
}

async function confirm(page: Page, title: string, action: string, cancel = false) {
  const dialog = page.getByRole('alertdialog', { name: title, exact: true })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveCount(1)
  await dialog.getByRole('button', { name: cancel ? 'Cancel' : action, exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

async function edit(page: Page, content: string) {
  const editor = page.locator('.cm-editor .cm-content[contenteditable="true"]')
  await expect(editor).toHaveCount(1)
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(content)
}

async function available(page: Page, spaceId: string, name: string) {
  const inventory = requireSkillData(await skillRequest(page, 'skillsList', { spaceId }))
  return inventory.groups.find(group => group.name === name)?.effectiveId
}

for (const operation of ['disable', 'delete'] as const) {
  test(`shared skill ${operation} preserves cancellation, controls and restart state`, managementAcceptance('capabilities.skills.remove', { operation }), async ({ managementApp, window }) => {
    const first = await seedManagedPerson(window, 'First shared skill consumer')
    const second = await seedManagedPerson(window, 'Second shared skill consumer')
    const consumerHas = async (page: Page, appId: string, name: string) => {
      const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appListAvailableSkills(id), appId)
      expect(result.success).toBe(true)
      return result.data?.some(skill => skill.dirName === name) ?? false
    }
    const input = skillImport('halo-temp', 'shared-evidence-check', 'Check every claim against supplied evidence.')
    const copy = requireSkillData(await skillRequest(window, 'skillsImport', input))
    const control = requireSkillData(await skillRequest(window, 'skillsImport', skillImport('halo-temp', 'unrelated-evidence-check', 'Keep the independent skill intact.')))
    const file = ownedSkillFile(managementApp.profile, copy)
    const before = readSkillPackage(managementApp.profile, copy)
    const controlBefore = readSkillPackage(managementApp.profile, control)
    await openSkill(window, copy)
    const action = operation === 'disable' ? 'Disable' : 'Delete'
    const deletion = window.getByRole('alertdialog', { name: 'Delete this skill?', exact: true })
    await window.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(deletion).toContainText(copy.displayName)
    await expect(deletion).toContainText('This skill and its supporting files will move to the Trash.')
    await confirm(window, 'Delete this skill?', 'Delete', true)
    expect(readSkillPackage(managementApp.profile, copy)).toEqual(before)
    expect(await available(window, 'halo-temp', copy.name)).toBe(copy.id)
    await window.getByRole('button', { name: action, exact: true }).click()
    if (operation === 'delete') await confirm(window, 'Delete this skill?', 'Delete')
    else await expect(window.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled()
    await expect(window.getByRole('alertdialog')).toHaveCount(0)
    await expect.poll(() => available(window, 'halo-temp', copy.name)).toBeUndefined()
    for (const person of [first, second]) {
      expect(await consumerHas(window, person.id, copy.name)).toBe(false)
      expect(await consumerHas(window, person.id, control.name)).toBe(true)
    }
    if (operation === 'disable') expect(readSkillPackage(managementApp.profile, copy)).toEqual(before)
    else expect(existsSync(file)).toBe(false)
    expect(readSkillPackage(managementApp.profile, control)).toEqual(controlBefore)
    const reopened = await managementApp.restart()
    expect(await available(reopened, 'halo-temp', copy.name)).toBeUndefined()
    if (operation === 'disable') {
      expect(readSkillPackage(managementApp.profile, copy)).toEqual(before)
      await openSkill(reopened, copy)
      await reopened.getByRole('button', { name: 'Enable', exact: true }).click()
      await expect(reopened.getByRole('button', { name: 'Disable', exact: true })).toBeEnabled()
      await expect(reopened.getByRole('alertdialog')).toHaveCount(0)
      await expect.poll(() => available(reopened, 'halo-temp', copy.name)).toBe(copy.id)
    } else {
      expect(existsSync(file)).toBe(false)
      const restored = requireSkillData(await skillRequest(reopened, 'skillsImport', { ...input, requestId: `${input.requestId}-explicit-restore` }))
      expect(readSkillPackage(managementApp.profile, restored)).toEqual(before)
    }
    expect(readSkillPackage(managementApp.profile, control)).toEqual(controlBefore)
    for (const person of [first, second]) {
      expect(await consumerHas(reopened, person.id, copy.name)).toBe(true)
      expect(await consumerHas(reopened, person.id, control.name)).toBe(true)
    }
  })
}

test('editing shared instructions retains cancelled drafts and supporting files and persists confirmed content', managementAcceptance('capabilities.skills.edit'), async ({ managementApp, window }) => {
  const first = await seedManagedPerson(window, 'First editing consumer')
  await seedManagedPerson(window, 'Second editing consumer')
  const copy = requireSkillData(await skillRequest(window, 'skillsImport', skillImport('halo-temp', 'editable-evidence-check', 'Original instruction.')))
  const control = requireSkillData(await skillRequest(window, 'skillsImport', skillImport('halo-temp', 'editing-control', 'Unrelated control.')))
  const before = readSkillPackage(managementApp.profile, copy)
  const controlBefore = readSkillPackage(managementApp.profile, control)
  const revised = before.content.replace('Original instruction.', 'Identify missing evidence before a conclusion.')
  await openManagedPersonSettings(window, first.spec.name)
  await window.getByRole('textbox', { name: 'Search skills', exact: true }).fill(copy.name)
  const preview = window.getByRole('button', { name: copy.displayName, exact: true })
  await expect(preview).toHaveAttribute('aria-expanded', 'false')
  await preview.click()
  await expect(preview).toHaveAttribute('aria-expanded', 'true')
  await expect(window.getByText('Original instruction.', { exact: true })).toBeVisible()
  await window.getByRole('button', { name: 'Open skill detail', exact: true }).click()
  const detail = window.getByRole('dialog', { name: 'Shared skill settings', exact: true })
  await expect(detail.getByRole('heading', { name: copy.displayName, level: 2, exact: true })).toBeVisible()
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(detail).toHaveCount(0)
  await openSkill(window, copy)
  await window.getByRole('button', { name: 'Edit', exact: true }).click()
  await edit(window, 'Discard this draft.')
  await window.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(readSkillPackage(managementApp.profile, copy)).toEqual(before)
  await window.getByRole('button', { name: 'Edit', exact: true }).click()
  await edit(window, revised)
  await window.getByRole('button', { name: 'Save', exact: true }).click()
  await confirm(window, 'Save shared resource changes?', 'Save', true)
  await expect(window.locator('.cm-content')).toContainText('Identify missing evidence before a conclusion.')
  expect(readSkillPackage(managementApp.profile, copy)).toEqual(before)
  await window.getByRole('button', { name: 'Save', exact: true }).click()
  await confirm(window, 'Save shared resource changes?', 'Save')
  await expect(window.locator('.cm-editor')).toHaveCount(0)
  expect(readSkillPackage(managementApp.profile, copy)).toEqual({ ...before, content: revised })
  const reopened = await managementApp.restart()
  await openSkill(reopened, copy)
  expect(requireSkillData(await skillRequest(reopened, 'skillsRead', skillRef(copy))).content).toBe(revised)
  expect(readSkillPackage(managementApp.profile, control)).toEqual(controlBefore)
})

test('a custom copy validates its command and preserves the original shared skill', managementAcceptance('capabilities.skills.custom-copy'), async ({ managementApp, window }) => {
  const source = requireSkillData(await skillRequest(window, 'skillsImport', skillImport('halo-temp', 'copy-source', 'Keep original instructions.')))
  const before = readSkillPackage(managementApp.profile, source)
  const modified = before.content.replace('Keep original instructions.', 'Use only the custom instructions.')
  await openSkill(window, source)
  await window.getByRole('button', { name: 'Edit', exact: true }).click()
  await edit(window, modified)
  await window.getByRole('button', { name: 'Save custom copy', exact: true }).click()
  const dialog = window.getByRole('dialog', { name: 'Save a custom skill copy', exact: true })
  const command = dialog.getByRole('textbox', { name: 'Command name', exact: true })
  for (const invalid of ['copy-source-invalid!', source.name]) {
    await command.fill(invalid)
    await dialog.getByRole('button', { name: 'Save custom copy', exact: true }).click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    expect(readSkillPackage(managementApp.profile, source)).toEqual(before)
    expect((requireSkillData(await skillRequest(window, 'skillsList', { spaceId: 'halo-temp', q: 'copy-source' }))).groups).toHaveLength(1)
  }
  await command.fill('copy-source-customized')
  await dialog.getByRole('button', { name: 'Save custom copy', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const inventory = requireSkillData(await skillRequest(window, 'skillsList', { spaceId: 'halo-temp' }))
  const copies = inventory.groups.find(group => group.name === 'copy-source-customized')!.copies
  expect(copies).toHaveLength(1)
  const copy = copies[0]
  expect(copy).toMatchObject({ source: 'personal', spaceId: 'halo-temp' })
  const bytes = readSkillPackage(managementApp.profile, copy)
  expect(bytes.content).toContain('name: copy-source-customized')
  expect(bytes.content).toContain('Use only the custom instructions.')
  expect(bytes.reference).toBe(before.reference)
  expect(bytes.binary).toBe(before.binary)
  const reopened = await managementApp.restart()
  expect(requireSkillData(await skillRequest(reopened, 'skillsRead', skillRef(copy))).content).toBe(bytes.content)
  expect(readSkillPackage(managementApp.profile, source)).toEqual(before)
})

for (const collision of [false, true]) {
  test(collision ? 'a conflicting scope move preserves both versions' : 'moving a global skill into one workspace survives restart', managementAcceptance(collision ? 'capabilities.skills.scope-conflict' : 'capabilities.skills.scope-move'), async ({ managementApp, window }) => {
    const destination = await seedManagedSpace(window, 'Scoped skills workspace')
    const source = requireSkillData(await skillRequest(window, 'skillsImport', skillImport(null, 'scope-moving-check', 'Global original.')))
    const control = requireSkillData(await skillRequest(window, 'skillsImport', skillImport(null, 'scope-control', 'Global control.')))
    const existing = collision ? requireSkillData(await skillRequest(window, 'skillsImport', skillImport(destination.id, source.name, 'Existing local version.'))) : undefined
    const before = readSkillPackage(managementApp.profile, source)
    const controlBefore = readSkillPackage(managementApp.profile, control)
    const existingBefore = existing && readSkillPackage(managementApp.profile, existing)
    const oldFile = ownedSkillFile(managementApp.profile, source)
    await window.reload()
    await openSkill(window, source)
    await window.getByRole('button', { name: 'Change workspace', exact: true }).click()
    await window.getByRole('button', { name: destination.name, exact: true }).click()
    if (collision) {
      await expect(window.getByRole('alert').filter({ hasText: 'A skill with this name already exists there. Choose another name or workspace.' })).toBeVisible()
      expect(readSkillPackage(managementApp.profile, source)).toEqual(before)
      expect(readSkillPackage(managementApp.profile, existing!)).toEqual(existingBefore)
    } else {
      await expect(window.getByRole('alertdialog', { name: 'Move this skill?', exact: true })).toContainText(destination.name)
      await confirm(window, 'Move this skill?', 'Move', true)
      expect(readSkillPackage(managementApp.profile, source)).toEqual(before)
      await window.getByRole('button', { name: 'Change workspace', exact: true }).click()
      await window.getByRole('button', { name: destination.name, exact: true }).click()
      await confirm(window, 'Move this skill?', 'Move')
      await expect.poll(() => existsSync(oldFile)).toBe(false)
    }
    const reopened = await managementApp.restart()
    const inventory = requireSkillData(await skillRequest(reopened, 'skillsList', { spaceId: destination.id }))
    const group = inventory.groups.find(group => group.name === source.name)!
    const selected = group.copies.find(copy => copy.id === group.effectiveId)!
    expect(readSkillPackage(managementApp.profile, selected)).toEqual(collision ? existingBefore : before)
    expect(await available(reopened, 'halo-temp', source.name)).toBe(collision ? source.id : undefined)
    expect(readSkillPackage(managementApp.profile, control)).toEqual(controlBefore)
    if (collision) expect(readSkillPackage(managementApp.profile, source)).toEqual(before)
  })
}

test('disabling a workspace skill reveals its global fallback without modifying either file', managementAcceptance('capabilities.skills.workspace-override'), async ({ managementApp, window }) => {
  const global = requireSkillData(await skillRequest(window, 'skillsImport', skillImport(null, 'override-evidence', 'Global evidence rule.')))
  const local = requireSkillData(await skillRequest(window, 'skillsImport', skillImport('halo-temp', global.name, 'Workspace evidence rule.')))
  const globalBefore = readSkillPackage(managementApp.profile, global)
  const localBefore = readSkillPackage(managementApp.profile, local)
  expect(await available(window, 'halo-temp', local.name)).toBe(local.id)
  await openSkill(window, local)
  await window.getByRole('button', { name: 'Disable', exact: true }).click()
  await expect(window.getByRole('alertdialog', { name: 'Disable this skill?', exact: true })).toContainText('The global version will still be available in this workspace.')
  await confirm(window, 'Disable this skill?', 'Disable', true)
  expect(await available(window, 'halo-temp', local.name)).toBe(local.id)
  expect(readSkillPackage(managementApp.profile, local)).toEqual(localBefore)
  expect(readSkillPackage(managementApp.profile, global)).toEqual(globalBefore)
  await window.getByRole('button', { name: 'Disable', exact: true }).click()
  await confirm(window, 'Disable this skill?', 'Disable')
  await expect.poll(() => available(window, 'halo-temp', local.name)).toBe(global.id)
  expect(readSkillPackage(managementApp.profile, local)).toEqual(localBefore)
  const reopened = await managementApp.restart()
  expect(await available(reopened, 'halo-temp', local.name)).toBe(global.id)
  await openSkill(reopened, local)
  await reopened.getByRole('button', { name: 'Enable', exact: true }).click()
  await expect(reopened.getByRole('button', { name: 'Disable', exact: true })).toBeEnabled()
  await expect(reopened.getByRole('alertdialog')).toHaveCount(0)
  await expect.poll(() => available(reopened, 'halo-temp', local.name)).toBe(local.id)
  expect(readSkillPackage(managementApp.profile, local)).toEqual(localBefore)
  expect(readSkillPackage(managementApp.profile, global)).toEqual(globalBefore)
})
