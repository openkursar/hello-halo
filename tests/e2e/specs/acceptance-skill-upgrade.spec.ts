import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { SkillCopy, SkillInventory, SkillSaveInput } from '../../../src/shared/types/skills'
import { test, expect, skillUpgradeAcceptance, type SkillServer } from '../fixtures/acceptance-skill-server'
import type { SeededLegacySkill } from '../fixtures/seed-legacy-skills-worker'
import { readSkillPackage } from '../fixtures/acceptance-skills'

const caseId = 'capabilities.skill-upgrade.legacy-db-read-edit'
test.describe.configure({ retries: 0 })
test.setTimeout(180000)

function card(page: Page, name: string): Locator {
  return page.locator('[role="button"]').filter({ has: page.getByRole('heading', { name, exact: true, level: 3 }) })
}

async function openLibrary(page: Page) {
  await page.locator('nav').getByRole('button', { name: 'Digital Humans', exact: true }).click()
  await page.getByRole('button', { name: 'Capability library', exact: true }).click()
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Global' })
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Refresh skills', exact: true })).toBeEnabled()
}

function recovered(inventory: SkillInventory, record: SeededLegacySkill): SkillCopy {
  const group = inventory.groups.find(group => group.name === record.name)
  expect(group, `The migrated ${record.kind} skill must be listed`).toBeDefined()
  expect(group!.copies).toHaveLength(1)
  const copy = group!.copies[0]
  expect(copy).toMatchObject({ source: 'personal', scope: 'global', spaceId: null, enabled: record.status === 'active', availability: record.status === 'paused' ? 'disabled' : 'available' })
  if (record.status === 'active') expect(group!.effectiveId).toBe(copy.id)
  else expect(group!.effectiveId).toBeUndefined()
  expect(realpathSync(copy.path)).toBe(realpathSync(record.destination))
  return copy
}

function expectedPackage(record: SeededLegacySkill, content = record.spec.skill_files!['SKILL.md']) {
  return { content, reference: record.spec.skill_files!['references/nested/evidence.md'], binary: record.spec.skill_assets!['templates/evidence.bin'].content }
}

function assertGuards(server: SkillServer, inventory: SkillInventory) {
  const rows = server.rows()
  for (const record of server.records.filter(record => ['uninstalled', 'deleted', 'control'].includes(record.kind))) {
    const row = rows.find(row => row.id === record.id)!
    expect(row.status).toBe(record.status)
    expect(JSON.parse(row.spec_json)).toEqual(record.spec)
    expect(JSON.parse(row.user_overrides_json)).toEqual(record.overrides)
    if (record.kind === 'control') {
      expect(readSkillPackage(server.profile, recovered(inventory, record))).toEqual(expectedPackage(record))
    } else {
      expect(inventory.groups.some(group => group.name === record.name)).toBe(false)
      expect(existsSync(record.destination)).toBe(false)
      expect(inventory.legacyRemoved.some(item => item.appId === record.id)).toBe(record.kind === 'uninstalled')
    }
  }
  for (const record of server.records) {
    for (const root of [join(server.profile, '.claude/skills'), join(server.profile, 'sdk-state/skills'), join(server.profile, '.halo/electron-user-data/claude-config/skills')]) {
      expect(existsSync(join(root, record.name)), 'Upgrade must not synchronize packages into obsolete engine directories').toBe(false)
    }
  }
}

async function assertCards(page: Page, server: SkillServer, records: SeededLegacySkill[]) {
  await expect(page.getByText('Engine support', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Some skills could not be loaded. Your other skills are still available.', { exact: true })).toHaveCount(0)
  for (const record of records) {
    const item = card(page, record.name)
    await expect(item).toHaveCount(1)
    await expect(item).toBeVisible()
    await expect(item).not.toContainText(server.profile)
    await expect(item).not.toContainText('SKILL.md')
    await expect(item).not.toContainText('Needs attention')
    await expect(item.locator('[class*="text-halo-warning"], [class*="bg-halo-warning"], [class*="text-yellow-"], [class*="bg-yellow-"]')).toHaveCount(0)
    if (record.kind === 'paused') {
      await expect(item.getByText('Disabled', { exact: true })).toBeVisible()
      await expect(item.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled()
    }
  }
}

async function replaceInstructions(page: Page, content: string) {
  const editor = page.locator('.cm-content[contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.click()
  await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText(content)
}

test('a missing skill stays manageable without touching other files', skillUpgradeAcceptance('capabilities.skill-upgrade.missing-cleanup'), async ({ skillServer: server }, info) => {
  const record = server.records.find(item => item.kind === 'active')!
  const control = server.records.find(item => item.kind === 'control')!
  const original = recovered(await server.list(), record)
  const untouched = readSkillPackage(server.profile, recovered(await server.list(), control))
  const page = await server.restart(() => {
    const within = relative(realpathSync(server.profile), realpathSync(dirname(original.path)))
    expect(within && !within.startsWith(`..${sep}`) && !isAbsolute(within)).toBeTruthy()
    rmSync(dirname(original.path), { recursive: true })
  })
  await openLibrary(page)
  const item = card(page, record.name)
  await item.hover()
  await expect(item.getByRole('button', { name: 'Disable', exact: true })).toBeEnabled()
  await item.getByRole('button', { name: 'Disable', exact: true }).click()
  await expect(item.getByRole('button', { name: 'Enable', exact: true })).toBeDisabled()
  await item.click()
  await expect(page.getByText('The skill file could not be found. Check its folder or import the skill again.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Delete this skill?', exact: true })
  await expect(confirmation).toContainText('Remove this entry from your library?')
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await server.list()).groups.some(group => group.name === record.name)).toBe(true)
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('heading', { name: record.name, level: 2, exact: true })).toHaveCount(0)
  expect((await server.list()).groups.some(group => group.name === record.name)).toBe(false)
  expect(server.rows().find(row => row.id === record.id)?.status).toBe('uninstalled')
  await server.restart()
  expect(existsSync(record.destination)).toBe(false)
  expect((await server.list()).groups.some(group => group.name === record.name)).toBe(false)
  expect(readSkillPackage(server.profile, recovered(await server.list(), control))).toEqual(untouched)
  await info.attach('missing-record-cleanup', { body: JSON.stringify({ record: record.id, control: control.id, rows: server.rows() }), contentType: 'application/json' })
})

test('saved legacy packages recover through the real library and edits survive restart without restoring removed files', skillUpgradeAcceptance(caseId), async ({ skillServer: server }, info) => {
  let page = server.page
  const active = server.records.find(record => record.kind === 'active')!
  const repaired = server.records.find(record => record.kind === 'incorrect-marker')!
  const paused = server.records.find(record => record.kind === 'paused')!
  const visible = server.records.filter(record => !['uninstalled', 'deleted'].includes(record.kind))
  const saves: SkillSaveInput[] = []
  const removals: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path === '/api/skills/save') saves.push(request.postDataJSON() as SkillSaveInput)
    if (['/api/skills/delete', '/api/skills/delete-legacy'].includes(path)) removals.push(path)
  })

  await test.step('Open the real global skill library and inspect recovered packages', async () => {
    await openLibrary(page)
    const inventory = await server.list()
    expect(inventory.warnings).toEqual([])
    await assertCards(page, server, visible)
    for (const record of visible) {
      const copy = recovered(inventory, record)
      expect(readSkillPackage(server.profile, copy)).toEqual(expectedPackage(record))
      const detail = await server.read({ id: copy.id, spaceId: null })
      expect(detail.content).toBe(record.spec.skill_files!['SKILL.md'])
      expect(detail.revision).not.toBe('')
      expect(detail.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'references/nested/evidence.md', binary: false }),
        expect.objectContaining({ path: 'templates/evidence.bin', binary: true, size: 7 }),
      ]))
    }
    const rows = server.rows()
    for (const record of [active, repaired, paused]) {
      const row = rows.find(row => row.id === record.id)!
      expect(row.status).toBe(record.status)
      expect(JSON.parse(row.user_overrides_json).skill).toMatchObject({ version: 1, filePath: record.destination })
      expect(JSON.parse(row.user_overrides_json).skill.migrationWarning).toBeUndefined()
      expect(JSON.parse(row.spec_json).skill_files).toBeUndefined()
    }
    assertGuards(server, inventory)
    await card(page, repaired.name).click()
    await expect(page.getByRole('heading', { name: repaired.name, exact: true, level: 2 })).toBeVisible()
    await expect(page.getByText(repaired.body, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back to capability library', exact: true }).click()
    await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Global' })
    await info.attach('recovered-skill-inventory', { body: JSON.stringify(inventory, null, 2), contentType: 'application/json' })
  })

  const initial = await server.read({ id: recovered(await server.list(), active).id, spaceId: null })
  const editedBody = 'Revised generic instructions saved through the real skill editor.'
  const edited = initial.content.replace(active.body, editedBody)
  await test.step('Read original instructions, cancel a draft, then save with the real revision', async () => {
    await card(page, active.name).click()
    await expect(page.getByRole('heading', { name: active.name, exact: true, level: 2 })).toBeVisible()
    await expect(page.getByText(active.body, { exact: true })).toBeVisible()
    await expect(page.getByText(/x-acceptance-metadata:|user-invocable:/)).toHaveCount(0)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await replaceInstructions(page, initial.content.replace(active.body, 'Discard this generic draft.'))
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByText(active.body, { exact: true })).toBeVisible()
    expect(saves).toHaveLength(0)
    expect(readFileSync(active.destination, 'utf8')).toBe(initial.content)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await replaceInstructions(page, edited)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const confirm = page.getByRole('alertdialog', { name: 'Save shared resource changes?', exact: true })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(editedBody, { exact: true })).toBeVisible()
    expect(saves).toHaveLength(1)
    expect(saves[0]).toEqual({ ref: { id: initial.copy.id, spaceId: null }, content: edited, revision: initial.revision })
    const after = await server.read({ id: initial.copy.id, spaceId: null })
    expect(after.revision).not.toBe(initial.revision)
    expect(readSkillPackage(server.profile, after.copy)).toEqual(expectedPackage(active, edited))
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    const deletion = page.getByRole('alertdialog', { name: 'Delete this skill?', exact: true })
    await expect(deletion).toBeVisible()
    await deletion.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(deletion).toHaveCount(0)
    expect(removals).toEqual([])
    expect(readFileSync(active.destination, 'utf8')).toBe(edited)
    await page.getByRole('button', { name: 'Back to capability library', exact: true }).click()
    await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Global' })
    await expect(card(page, active.name)).toBeVisible()
  })

  await test.step('Restart the same isolated profile and read the saved instructions again', async () => {
    page = await server.restart()
    await openLibrary(page)
    const inventory = await server.list()
    expect(inventory.warnings).toEqual([])
    await assertCards(page, server, visible)
    for (const record of visible) expect(readSkillPackage(server.profile, recovered(inventory, record))).toEqual(expectedPackage(record, record === active ? edited : undefined))
    await card(page, active.name).click()
    await expect(page.getByRole('heading', { name: active.name, exact: true, level: 2 })).toBeVisible()
    await expect(page.getByText(editedBody, { exact: true })).toBeVisible()
    await expect(page.getByText(active.body, { exact: true })).toHaveCount(0)
    assertGuards(server, inventory)
  })

  await test.step('Remove only an owned migrated package outside the app and verify no resurrection', async () => {
    page = await server.restart(() => {
      const owned = relative(realpathSync(server.profile), realpathSync(dirname(repaired.destination)))
      expect(owned && owned !== '..' && !owned.startsWith(`..${sep}`) && !isAbsolute(owned), 'External removal must stay inside this disposable profile').toBeTruthy()
      rmSync(dirname(repaired.destination), { recursive: true })
    })
    await openLibrary(page)
    const inventory = await server.list()
    const removed = inventory.groups.find(group => group.name === repaired.name)
    expect(removed?.effectiveId).toBeUndefined()
    expect(removed?.copies.every(copy => copy.availability === 'missing') ?? true).toBe(true)
    expect(existsSync(repaired.destination)).toBe(false)
    expect(readSkillPackage(server.profile, recovered(inventory, active))).toEqual(expectedPackage(active, edited))
    recovered(inventory, paused)
    assertGuards(server, inventory)
    await card(page, active.name).click()
    await expect(page.getByText(editedBody, { exact: true })).toBeVisible()
    expect(removals, 'This case never authorizes a system Trash operation').toEqual([])
    await info.attach('skill-upgrade-final-state', { body: JSON.stringify({ inventory, rows: server.rows(), saves, trashRequests: removals, deletedExternally: repaired.destination }, null, 2), contentType: 'application/json' })
  })
})
