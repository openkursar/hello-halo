import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { AvailableSkill, InstalledApp } from '../../../src/shared/apps/app-types'
import type { SkillSpec } from '../../../src/shared/apps/spec-types'
import {
  test, expect, managementAcceptance, seedManagedPerson, seedManagedSpace,
} from '../fixtures/acceptance-management'
import { waitForHomePage } from '../fixtures/helpers'

test.setTimeout(90000)

interface InstalledSkill extends InstalledApp {
  spec: SkillSpec
}

function skillContent(name: string, heading: string, instruction: string) {
  return `---\nname: ${name}\ndescription: Inspect isolated acceptance evidence\nuser-invocable: true\n---\n\n# ${heading}\n\n${instruction}\n`
}

async function readSkill(page: Page, id: string): Promise<InstalledSkill> {
  const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appGet(id), id)
  expect(result.success).toBe(true)
  expect(result.data).toBeTruthy()
  const app = result.data as InstalledApp
  expect(app.spec.type).toBe('skill')
  return app as InstalledSkill
}

async function installedSkills(page: Page): Promise<InstalledSkill[]> {
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.appList({ type: 'skill' }))
  expect(result.success).toBe(true)
  const apps = result.data as InstalledApp[]
  expect(apps.every(app => app.spec.type === 'skill')).toBe(true)
  return apps as InstalledSkill[]
}

async function installSkill(page: Page, input: { name: string; displayName: string; scope: string | null; content: string }): Promise<InstalledSkill> {
  const result = await page.evaluate(({ name, displayName, scope, content }) => (window as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId: scope,
    spec: {
      spec_version: '1.0', type: 'skill', name, display_name: displayName, version: '1.0.0',
      author: 'Acceptance author', description: 'Inspect isolated acceptance evidence',
      skill_files: { 'SKILL.md': content, 'references/checklist.md': 'Supporting evidence must remain unchanged.\n' },
    },
  }), input)
  expect(result.success, 'Skill preconditions must install through production orchestration').toBe(true)
  const { appId } = result.data as { appId: string }
  const installed = await readSkill(page, appId)
  expect(installed).toMatchObject({
    status: 'active', specId: input.name, spaceId: input.scope,
    spec: { name: input.name, display_name: input.displayName },
  })
  return installed
}

async function installConsumer(page: Page, name: string, spaceId: string): Promise<string> {
  const result = await page.evaluate(({ name, spaceId }) => (window as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId,
    spec: {
      spec_version: '1.0', type: 'automation', name, version: '1.0.0', author: 'Acceptance author',
      description: 'Uses skills inherited from its workspace.', system_prompt: 'Review only supplied local evidence.',
      subscriptions: [], requires: {}, config_schema: [], permissions: [],
    },
  }), { name, spaceId })
  expect(result.success).toBe(true)
  return (result.data as { appId: string }).appId
}

async function availableTo(page: Page, appId: string): Promise<AvailableSkill[]> {
  const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appListAvailableSkills(id), appId)
  expect(result.success, 'Availability must come from the real skill-discovery path').toBe(true)
  return result.data ?? []
}

async function findAvailable(page: Page, appId: string, command: string): Promise<AvailableSkill> {
  await expect.poll(async () => (await availableTo(page, appId)).filter(skill => skill.dirName === command).length).toBe(1)
  return (await availableTo(page, appId)).find(skill => skill.dirName === command)!
}

function assertProfilePath(profile: string, file: string) {
  const inside = relative(profile, file)
  expect(inside.length).toBeGreaterThan(0)
  expect(isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)).toBe(false)
}

async function openSkillLibrary(page: Page) {
  await waitForHomePage(page)
  const peopleBack = page.getByRole('button', { name: 'All digital humans', exact: true })
  const capabilityBack = page.getByRole('button', { name: 'Back to capability library', exact: true })
  if (await capabilityBack.isVisible()) await capabilityBack.click()
  else if (await peopleBack.isVisible()) await peopleBack.click()
  await page.getByRole('button', { name: 'Digital Humans', exact: true }).first().click()
  const library = page.getByRole('button', { name: 'Capability library', exact: true })
  await expect(library).toBeVisible()
  await library.click()
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await expect(page.getByPlaceholder('Search Skills', { exact: true })).toBeVisible()
}

async function openSkill(page: Page, displayName: string) {
  await openSkillLibrary(page)
  await page.getByPlaceholder('Search Skills', { exact: true }).fill(displayName)
  const card = page.locator('[role="button"]').filter({ has: page.getByRole('heading', { name: displayName, level: 3, exact: true }) })
  await expect(card).toHaveCount(1)
  await card.click()
  await expect(page.getByRole('heading', { name: displayName, level: 2, exact: true })).toBeVisible()
}

async function inspectChange(page: Page, title: string, consumers: string[]): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: title, exact: true })
  await expect(dialog).toBeVisible()
  for (const name of consumers) await expect(dialog.getByText(name, { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Confirm change', exact: true })).toBeEnabled()
  return dialog
}

async function replaceInstructions(page: Page, content: string) {
  const editor = page.locator('.cm-editor .cm-content[contenteditable="true"]')
  await expect(editor).toHaveCount(1)
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(content)
}

async function selectSkillScope(page: Page, name: string) {
  const option = page.getByRole('button', { name, exact: true })
  if (!(await option.isVisible())) await page.getByTitle('Click to change space', { exact: true }).click()
  await option.click()
}

for (const operation of ['disable', 'uninstall'] as const) {
  test(`shared skill ${operation} requires confirmation and its availability survives restart`, managementAcceptance('capabilities.skills.remove', { operation }), async ({ managementApp, window }) => {
    const first = await seedManagedPerson(window, 'First skill consumer')
    const second = await seedManagedPerson(window, 'Second skill consumer')
    const content = skillContent('shared-evidence-check', 'Shared evidence check', 'Check every claim against the supplied evidence.')
    const skill = await installSkill(window, { name: 'shared-evidence-check', displayName: 'Shared evidence check', scope: 'halo-temp', content })
    const controlContent = skillContent('unrelated-evidence-check', 'Unrelated evidence check', 'Keep this independent skill intact.')
    const control = await installSkill(window, { name: 'unrelated-evidence-check', displayName: 'Unrelated evidence check', scope: 'halo-temp', content: controlContent })
    const discovered = await findAvailable(window, first.id, skill.specId)
    const controlDiscovered = await findAvailable(window, first.id, control.specId)
    assertProfilePath(managementApp.profile, discovered.path)
    assertProfilePath(managementApp.profile, controlDiscovered.path)
    expect((await availableTo(window, second.id)).some(item => item.dirName === skill.specId)).toBe(true)
    const originalFile = readFileSync(join(discovered.path, 'SKILL.md'), 'utf8')
    const controlFile = readFileSync(join(controlDiscovered.path, 'SKILL.md'), 'utf8')
    await openSkill(window, skill.spec.display_name!)

    const action = operation === 'disable' ? 'Disable' : 'Uninstall'
    const title = operation === 'disable' ? 'Change shared resource availability?' : 'Remove this shared resource?'
    await window.getByRole('button', { name: action, exact: true }).click()
    let confirmation = await inspectChange(window, title, [first.spec.name, second.spec.name])
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await readSkill(window, skill.id)).status).toBe('active')
    expect(readFileSync(join(discovered.path, 'SKILL.md'), 'utf8')).toBe(originalFile)
    expect((await availableTo(window, second.id)).some(item => item.dirName === skill.specId)).toBe(true)

    await window.getByRole('button', { name: action, exact: true }).click()
    confirmation = await inspectChange(window, title, [first.spec.name, second.spec.name])
    await confirmation.getByRole('button', { name: 'Confirm change', exact: true }).click()
    const status = operation === 'disable' ? 'paused' : 'uninstalled'
    await expect.poll(async () => (await readSkill(window, skill.id)).status).toBe(status)
    for (const consumer of [first.id, second.id]) {
      await expect.poll(async () => (await availableTo(window, consumer)).some(item => item.dirName === skill.specId)).toBe(false)
      expect((await availableTo(window, consumer)).some(item => item.dirName === control.specId)).toBe(true)
    }
    expect(existsSync(discovered.path)).toBe(false)
    expect(readFileSync(join(controlDiscovered.path, 'SKILL.md'), 'utf8')).toBe(controlFile)

    const reopened = await managementApp.restart()
    expect((await readSkill(reopened, skill.id)).status).toBe(status)
    for (const consumer of [first.id, second.id]) expect((await availableTo(reopened, consumer)).some(item => item.dirName === skill.specId)).toBe(false)
    expect(existsSync(discovered.path)).toBe(false)
    expect((await readSkill(reopened, control.id)).spec).toEqual(control.spec)
    expect(readFileSync(join(controlDiscovered.path, 'SKILL.md'), 'utf8')).toBe(controlFile)

    if (operation === 'disable') {
      await openSkill(reopened, skill.spec.display_name!)
      await reopened.getByRole('button', { name: 'Enable', exact: true }).click()
      const restore = await inspectChange(reopened, 'Change shared resource availability?', [first.spec.name, second.spec.name])
      await restore.getByRole('button', { name: 'Confirm change', exact: true }).click()
    } else {
      await openSkillLibrary(reopened)
      await reopened.getByPlaceholder('Search Skills', { exact: true }).fill(skill.spec.display_name!)
      await expect(reopened.getByRole('button', { name: /^Uninstalled/ })).toBeVisible()
      const removedCard = reopened.locator('[role="button"]').filter({ has: reopened.getByRole('heading', { name: skill.spec.display_name!, level: 3, exact: true }) })
      await expect(removedCard).toHaveCount(1)
      await removedCard.click()
      await expect(reopened.getByText('This app has been uninstalled', { exact: true })).toBeVisible()
      await reopened.getByRole('button', { name: 'Reinstall App', exact: true }).click()
    }
    await expect.poll(async () => (await readSkill(reopened, skill.id)).status).toBe('active')
    for (const consumer of [first.id, second.id]) expect((await findAvailable(reopened, consumer, skill.specId)).content).toContain('Check every claim against the supplied evidence.')
    expect(readFileSync(join(discovered.path, 'SKILL.md'), 'utf8')).toBe(originalFile)
    expect(readFileSync(join(discovered.path, 'references/checklist.md'), 'utf8')).toBe('Supporting evidence must remain unchanged.\n')
    expect(readFileSync(join(controlDiscovered.path, 'SKILL.md'), 'utf8')).toBe(controlFile)
  })
}

test('editing shared instructions retains cancelled drafts and supporting files and persists the confirmed content', managementAcceptance('capabilities.skills.edit'), async ({ managementApp, window }) => {
  const first = await seedManagedPerson(window, 'First editing consumer')
  const second = await seedManagedPerson(window, 'Second editing consumer')
  const original = skillContent('editable-evidence-check', 'Original evidence instructions', 'Record the original review instruction.')
  const revised = skillContent('editable-evidence-check', 'Revised evidence instructions', 'Identify missing evidence before writing a conclusion.')
  const skill = await installSkill(window, { name: 'editable-evidence-check', displayName: 'Editable evidence check', scope: 'halo-temp', content: original })
  const control = await installSkill(window, { name: 'editing-control', displayName: 'Editing control', scope: 'halo-temp', content: skillContent('editing-control', 'Control instructions', 'Do not change these instructions.') })
  const discovered = await findAvailable(window, first.id, skill.specId)
  const controlLocation = await findAvailable(window, first.id, control.specId)
  assertProfilePath(managementApp.profile, discovered.path)
  assertProfilePath(managementApp.profile, controlLocation.path)
  const onDisk = readFileSync(join(discovered.path, 'SKILL.md'), 'utf8')
  const supporting = readFileSync(join(discovered.path, 'references/checklist.md'), 'utf8')
  const controlFile = readFileSync(join(controlLocation.path, 'SKILL.md'), 'utf8')
  await openSkill(window, skill.spec.display_name!)
  await window.getByRole('button', { name: 'Edit', exact: true }).click()
  await replaceInstructions(window, 'This edit must be discarded.')
  await window.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await readSkill(window, skill.id)).spec).toEqual(skill.spec)
  expect(readFileSync(join(discovered.path, 'SKILL.md'), 'utf8')).toBe(onDisk)

  await window.getByRole('button', { name: 'Edit', exact: true }).click()
  await replaceInstructions(window, revised)
  await window.getByRole('button', { name: 'Save', exact: true }).click()
  let confirmation = await inspectChange(window, 'Save shared resource changes?', [first.spec.name, second.spec.name])
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(window.locator('.cm-content')).toContainText('Identify missing evidence before writing a conclusion.')
  expect((await readSkill(window, skill.id)).spec).toEqual(skill.spec)
  expect(readFileSync(join(discovered.path, 'SKILL.md'), 'utf8')).toBe(onDisk)
  await window.getByRole('button', { name: 'Save', exact: true }).click()
  confirmation = await inspectChange(window, 'Save shared resource changes?', [first.spec.name, second.spec.name])
  await confirmation.getByRole('button', { name: 'Confirm change', exact: true }).click()
  await expect(window.locator('.cm-editor')).toHaveCount(0)
  await expect(window.getByRole('heading', { name: 'Revised evidence instructions', exact: true })).toBeVisible()
  await expect.poll(async () => (await readSkill(window, skill.id)).spec.skill_files?.['SKILL.md']).toBe(revised)
  expect(readFileSync(join(discovered.path, 'SKILL.md'), 'utf8')).toBe(revised)
  expect(readFileSync(join(discovered.path, 'references/checklist.md'), 'utf8')).toBe(supporting)
  expect((await readSkill(window, control.id)).spec).toEqual(control.spec)
  expect(readFileSync(join(controlLocation.path, 'SKILL.md'), 'utf8')).toBe(controlFile)

  const reopened = await managementApp.restart()
  await openSkill(reopened, skill.spec.display_name!)
  await expect(reopened.getByRole('heading', { name: 'Revised evidence instructions', exact: true })).toBeVisible()
  for (const consumer of [first.id, second.id]) expect((await findAvailable(reopened, consumer, skill.specId)).content).toContain('Identify missing evidence before writing a conclusion.')
  expect(readFileSync(join(discovered.path, 'references/checklist.md'), 'utf8')).toBe(supporting)
  expect((await readSkill(reopened, control.id)).spec).toEqual(control.spec)
  expect(readFileSync(join(controlLocation.path, 'SKILL.md'), 'utf8')).toBe(controlFile)
})

test('a custom copy validates its command and preserves the original shared skill', managementAcceptance('capabilities.skills.custom-copy'), async ({ managementApp, window }) => {
  const person = await seedManagedPerson(window, 'Custom copy consumer')
  const original = skillContent('copy-source', 'Source instructions', 'Keep the original shared instructions.')
  const modified = skillContent('copy-source', 'Custom instructions', 'Apply only these customized instructions to the copy.')
  const source = await installSkill(window, { name: 'copy-source', displayName: 'Copy source', scope: 'halo-temp', content: original })
  const originalLocation = await findAvailable(window, person.id, source.specId)
  assertProfilePath(managementApp.profile, originalLocation.path)
  const originalFile = readFileSync(join(originalLocation.path, 'SKILL.md'), 'utf8')
  await openSkill(window, source.spec.display_name!)
  await window.getByRole('button', { name: 'Edit', exact: true }).click()
  await replaceInstructions(window, modified)
  await window.getByRole('button', { name: 'Save custom copy', exact: true }).click()
  const dialog = window.getByRole('dialog', { name: 'Save a custom skill copy', exact: true })
  const command = dialog.getByRole('textbox', { name: 'Command name', exact: true })
  const copyIds = async () => (await installedSkills(window)).filter(app => app.specId.startsWith('copy-source')).map(app => app.id).sort()
  expect(await copyIds()).toEqual([source.id])
  await command.fill('copy-source-invalid!')
  await dialog.getByRole('button', { name: 'Save custom copy', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Use lowercase letters, numbers and hyphens for the command name.')
  expect(await copyIds()).toEqual([source.id])
  await command.fill(source.specId)
  await dialog.getByRole('button', { name: 'Save custom copy', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('This command name already exists. Choose another name.')
  expect(await copyIds()).toEqual([source.id])
  expect((await readSkill(window, source.id)).spec).toEqual(source.spec)
  expect(readFileSync(join(originalLocation.path, 'SKILL.md'), 'utf8')).toBe(originalFile)
  await command.fill('copy-source-customized')
  await dialog.getByRole('button', { name: 'Save custom copy', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const copy = await findAvailable(window, person.id, 'copy-source-customized')
  assertProfilePath(managementApp.profile, copy.path)
  expect(copy.content).toContain('Apply only these customized instructions to the copy.')
  expect(copy.content).toContain('name: copy-source-customized')
  expect((await readSkill(window, source.id)).spec).toEqual(source.spec)
  expect(readFileSync(join(originalLocation.path, 'SKILL.md'), 'utf8')).toBe(originalFile)
  expect(readFileSync(join(copy.path, 'references/checklist.md'), 'utf8')).toBe('Supporting evidence must remain unchanged.\n')

  const reopened = await managementApp.restart()
  await openSkill(reopened, 'copy-source-customized')
  await expect(reopened.getByRole('heading', { name: 'Custom instructions', exact: true })).toBeVisible()
  const copies = (await installedSkills(reopened)).filter(app => app.specId === 'copy-source-customized')
  expect(copies).toHaveLength(1)
  expect(copies[0]).toMatchObject({ spaceId: 'halo-temp', spec: { name: 'copy-source-customized', store: { install_source: 'manual' } } })
  expect(copies[0].id).not.toBe(source.id)
  expect((await readSkill(reopened, source.id)).spec).toEqual(source.spec)
})

test('moving a global skill into one workspace changes only that scope and survives restart', managementAcceptance('capabilities.skills.scope-move'), async ({ managementApp, window }) => {
  const first = await seedManagedPerson(window, 'Global skill consumer')
  const destination = await seedManagedSpace(window, 'Scoped skills workspace')
  const secondId = await installConsumer(window, 'Scoped skill consumer', destination.id)
  const content = skillContent('scope-moving-check', 'Scope moving instructions', 'Keep these instructions while changing availability scope.')
  const skill = await installSkill(window, { name: 'scope-moving-check', displayName: 'Scope moving check', scope: null, content })
  const control = await installSkill(window, { name: 'scope-control', displayName: 'Global scope control', scope: null, content: skillContent('scope-control', 'Global control', 'Keep global availability unchanged.') })
  const oldLocation = await findAvailable(window, first.id, skill.specId)
  expect(oldLocation.scope).toBe('global')
  expect((await findAvailable(window, secondId, skill.specId)).path).toBe(oldLocation.path)
  assertProfilePath(managementApp.profile, oldLocation.path)
  await window.reload()
  await openSkill(window, skill.spec.display_name!)
  await selectSkillScope(window, destination.name)
  let confirmation = await inspectChange(window, 'Change this skill’s scope?', [first.spec.name, 'Scoped skill consumer'])
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await readSkill(window, skill.id)).spaceId).toBeNull()
  expect(existsSync(oldLocation.path)).toBe(true)
  await selectSkillScope(window, destination.name)
  confirmation = await inspectChange(window, 'Change this skill’s scope?', [first.spec.name, 'Scoped skill consumer'])
  await confirmation.getByRole('button', { name: 'Confirm change', exact: true }).click()
  await expect.poll(async () => (await readSkill(window, skill.id)).spaceId).toBe(destination.id)
  await expect.poll(async () => (await availableTo(window, first.id)).some(item => item.dirName === skill.specId)).toBe(false)
  const moved = await findAvailable(window, secondId, skill.specId)
  assertProfilePath(managementApp.profile, moved.path)
  expect(moved.scope).toBe('space')
  expect(moved.path).not.toBe(oldLocation.path)
  expect(existsSync(oldLocation.path)).toBe(false)
  expect(readFileSync(join(moved.path, 'SKILL.md'), 'utf8')).toBe(content)
  expect(readFileSync(join(moved.path, 'references/checklist.md'), 'utf8')).toBe('Supporting evidence must remain unchanged.\n')
  for (const consumer of [first.id, secondId]) {
    const unaffected = await findAvailable(window, consumer, control.specId)
    expect(unaffected.scope).toBe('global')
    expect(unaffected.content).toContain('Keep global availability unchanged.')
  }

  const reopened = await managementApp.restart()
  expect((await readSkill(reopened, skill.id)).spaceId).toBe(destination.id)
  expect((await availableTo(reopened, first.id)).some(item => item.dirName === skill.specId)).toBe(false)
  expect((await findAvailable(reopened, secondId, skill.specId)).path).toBe(moved.path)
  expect((await readSkill(reopened, control.id)).spec).toEqual(control.spec)
})

test('a conflicting scope move reports failure and preserves both installed versions', managementAcceptance('capabilities.skills.scope-conflict'), async ({ managementApp, window }) => {
  const person = await seedManagedPerson(window, 'Scope collision consumer')
  const destination = await seedManagedSpace(window, 'Occupied skill scope')
  const secondId = await installConsumer(window, 'Occupied scope consumer', destination.id)
  const source = await installSkill(window, { name: 'colliding-skill', displayName: 'Global collision source', scope: null, content: skillContent('colliding-skill', 'Global collision instructions', 'Keep the global version.') })
  const existing = await installSkill(window, { name: 'colliding-skill', displayName: 'Existing workspace version', scope: destination.id, content: skillContent('colliding-skill', 'Workspace collision instructions', 'Keep the existing workspace version.') })
  const globalLocation = await findAvailable(window, person.id, source.specId)
  const localLocation = await findAvailable(window, secondId, source.specId)
  assertProfilePath(managementApp.profile, globalLocation.path)
  assertProfilePath(managementApp.profile, localLocation.path)
  const globalFile = readFileSync(join(globalLocation.path, 'SKILL.md'), 'utf8')
  const localFile = readFileSync(join(localLocation.path, 'SKILL.md'), 'utf8')
  await window.reload()
  await openSkill(window, source.spec.display_name!)
  await selectSkillScope(window, destination.name)
  const confirmation = await inspectChange(window, 'Change this skill’s scope?', [person.spec.name])
  await confirmation.getByRole('button', { name: 'Confirm change', exact: true }).click()
  await expect(confirmation.getByRole('alert')).toHaveText('Could not apply this change. Your draft is retained. Please retry.')
  expect((await readSkill(window, source.id)).spaceId).toBeNull()
  expect((await readSkill(window, existing.id)).spaceId).toBe(destination.id)
  expect(readFileSync(join(globalLocation.path, 'SKILL.md'), 'utf8')).toBe(globalFile)
  expect(readFileSync(join(localLocation.path, 'SKILL.md'), 'utf8')).toBe(localFile)
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  const reopened = await managementApp.restart()
  expect((await readSkill(reopened, source.id)).spaceId).toBeNull()
  expect((await readSkill(reopened, existing.id)).spaceId).toBe(destination.id)
  expect((await findAvailable(reopened, person.id, source.specId)).content).toContain('Keep the global version.')
  expect((await findAvailable(reopened, secondId, source.specId)).content).toContain('Keep the existing workspace version.')
})

test('disabling a workspace skill reveals the same-name global version without modifying either saved definition', managementAcceptance('capabilities.skills.workspace-override'), async ({ managementApp, window }) => {
  const person = await seedManagedPerson(window, 'Override consumer')
  const globalSkill = await installSkill(window, { name: 'override-evidence', displayName: 'Global evidence version', scope: null, content: skillContent('override-evidence', 'Global evidence instructions', 'Use the global evidence rule.') })
  const local = await installSkill(window, { name: 'override-evidence', displayName: 'Workspace evidence version', scope: 'halo-temp', content: skillContent('override-evidence', 'Workspace evidence instructions', 'Use the workspace evidence rule.') })
  const chosen = await findAvailable(window, person.id, local.specId)
  assertProfilePath(managementApp.profile, chosen.path)
  expect(chosen.scope).toBe('space')
  expect(chosen.content).toContain('Use the workspace evidence rule.')
  await openSkill(window, local.spec.display_name!)
  await window.getByRole('button', { name: 'Disable', exact: true }).click()
  let confirmation = await inspectChange(window, 'Change shared resource availability?', [person.spec.name])
  await confirmation.getByRole('button', { name: 'Confirm change', exact: true }).click()
  await expect.poll(async () => (await readSkill(window, local.id)).status).toBe('paused')
  const fallback = await findAvailable(window, person.id, globalSkill.specId)
  assertProfilePath(managementApp.profile, fallback.path)
  expect(fallback.scope).toBe('global')
  expect(fallback.path).not.toBe(chosen.path)
  expect(fallback.content).toContain('Use the global evidence rule.')
  expect((await readSkill(window, globalSkill.id)).spec).toEqual(globalSkill.spec)
  expect((await readSkill(window, local.id)).spec).toEqual(local.spec)
  expect(existsSync(chosen.path)).toBe(false)
  const globalFile = readFileSync(join(fallback.path, 'SKILL.md'), 'utf8')

  const reopened = await managementApp.restart()
  expect((await findAvailable(reopened, person.id, globalSkill.specId)).scope).toBe('global')
  await openSkill(reopened, local.spec.display_name!)
  await reopened.getByRole('button', { name: 'Enable', exact: true }).click()
  confirmation = await inspectChange(reopened, 'Change shared resource availability?', [person.spec.name])
  await confirmation.getByRole('button', { name: 'Confirm change', exact: true }).click()
  await expect.poll(async () => (await findAvailable(reopened, person.id, local.specId)).scope).toBe('space')
  expect((await findAvailable(reopened, person.id, local.specId)).content).toContain('Use the workspace evidence rule.')
  expect((await readSkill(reopened, globalSkill.id)).spec).toEqual(globalSkill.spec)
  expect(readFileSync(join(fallback.path, 'SKILL.md'), 'utf8')).toBe(globalFile)
})
