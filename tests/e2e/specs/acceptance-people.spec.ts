import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { stringify } from 'yaml'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import {
  test, expect, managementAcceptance, listManagedPeople, openManagedPerson,
  openManagedPersonSettings, readManagedPerson, seedManagedPerson, seedManagedSpace,
} from '../fixtures/acceptance-management'
import { navigateToApps } from '../fixtures/helpers'

test.setTimeout(90000)

async function openCreation(page: Page): Promise<Locator> {
  await navigateToApps(page)
  await page.getByRole('button', { name: 'Create Digital Human', exact: true }).first().click()
  const form = page.locator('.fixed.inset-0').filter({ has: page.getByRole('heading', { name: 'Create Digital Human', level: 2, exact: true }) })
  await expect(form).toBeVisible()
  return form
}

async function uninstallPerson(page: Page, name: string) {
  await openManagedPerson(page, name)
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Uninstall this digital human?', exact: true })
  await expect(confirmation).toContainText('Its work history is kept')
  return confirmation
}

test('the visual form creates a person with its instructions and daily schedule in the selected workspace', managementAcceptance('people.create.form'), async ({ managementApp, window }) => {
  const space = await seedManagedSpace(window, 'People installation workspace')
  await window.reload()
  const form = await openCreation(window)
  const name = 'Daily evidence reviewer'
  const description = 'Reviews a local evidence folder once a day.'
  const prompt = 'Review only the supplied local evidence. Explain missing evidence before making a conclusion.'
  await form.getByPlaceholder('My Digital Human', { exact: true }).fill(name)
  await form.getByPlaceholder('What does this app do?', { exact: true }).fill(description)
  await form.getByPlaceholder('Your name', { exact: true }).fill('Acceptance author')
  await form.getByPlaceholder('Describe what this app should do on each scheduled run. This is the core instruction that drives the AI.', { exact: true }).fill(prompt)
  await form.getByRole('button', { name: '1d', exact: true }).click()
  await form.locator('select').filter({ has: window.locator(`option[value="${space.id}"]`) }).selectOption(space.id)
  await form.getByRole('button', { name: 'Create Digital Human', exact: true }).click()
  await expect(form).toHaveCount(0)
  await expect.poll(async () => (await listManagedPeople(window)).filter(person => person.spec.name === name).length).toBe(1)
  const person = (await listManagedPeople(window)).find(person => person.spec.name === name)!
  expect(person).toMatchObject({ spaceId: space.id, spec: { name, description, author: 'Acceptance author', system_prompt: prompt } })
  expect(person.spec).toMatchObject({ type: 'automation', subscriptions: [expect.objectContaining({ source: { type: 'schedule', config: { every: '1d' } } })] })

  const reopened = await managementApp.restart()
  await openManagedPersonSettings(reopened, name)
  await expect(reopened.locator('#settings-group-identity input[type="text"]').first()).toHaveValue(name)
  await expect(reopened.locator('#settings-group-identity textarea')).toHaveValue(prompt)
  const saved = await readManagedPerson(reopened, person.id)
  expect(saved.spaceId).toBe(space.id)
  expect(saved.spec).toEqual(person.spec)
})

test('package import previews valid content and rejects an invalid archive without installing anything from it', managementAcceptance('people.create.import'), async ({ managementApp, window }, testInfo) => {
  const name = 'Imported evidence reviewer'
  const invalid = testInfo.outputPath('invalid-person.zip')
  const valid = testInfo.outputPath('valid-person.zip')
  mkdirSync(dirname(invalid), { recursive: true })
  writeFileSync(invalid, zipSync({ 'README.txt': strToU8('This bundle deliberately has no specification.') }))
  const spec = {
    spec_version: '1.0', name, version: '1.0.0', author: 'Acceptance author', type: 'automation',
    description: 'Reviews only isolated imported evidence.', system_prompt: 'Report only facts present in the supplied evidence.',
    subscriptions: [], requires: {}, config_schema: [], permissions: [],
  }
  writeFileSync(valid, zipSync({ 'spec.yaml': strToU8(stringify(spec)) }))
  const before = (await listManagedPeople(window)).map(person => person.id).sort()
  const form = await openCreation(window)
  await form.getByRole('button', { name: 'Import', exact: true }).click()
  await form.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(invalid)
  await expect(form.getByText('Validation failed', { exact: true })).toBeVisible()
  expect((await listManagedPeople(window)).map(person => person.id).sort()).toEqual(before)
  await form.getByRole('button', { name: 'Try again', exact: true }).click()
  await form.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(valid)
  await expect(form.getByText(name, { exact: true })).toBeVisible()
  expect((await listManagedPeople(window)).some(person => person.spec.name === name)).toBe(false)
  await form.locator('select').filter({ has: window.locator('option[value="halo-temp"]') }).selectOption('halo-temp')
  await form.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(form.getByText('Installation complete', { exact: true })).toBeVisible()
  const installed = (await listManagedPeople(window)).filter(person => person.spec.name === name)
  expect(installed).toHaveLength(1)
  expect(installed[0]).toMatchObject({ spaceId: 'halo-temp', spec })
  const reopened = await managementApp.restart()
  await openManagedPersonSettings(reopened, name)
  expect((await readManagedPerson(reopened, installed[0].id)).spec).toMatchObject(spec)
})

test('identity and instruction drafts can be reset and saved without changing a different person', managementAcceptance('people.settings.unsaved'), async ({ managementApp, window }) => {
  const person = await seedManagedPerson(window, 'Editable reviewer')
  const other = await seedManagedPerson(window, 'Independent reviewer')
  await openManagedPersonSettings(window, person.spec.name)
  const identity = window.locator('#settings-group-identity')
  const name = identity.locator('input[type="text"]').first()
  const description = identity.locator('input[type="text"]').nth(1)
  const prompt = identity.locator('textarea')
  await name.fill('Discard this identity draft')
  await identity.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(name).toHaveValue(person.spec.name)
  expect((await readManagedPerson(window, person.id)).spec).toEqual(person.spec)

  const changed = { name: 'Saved evidence reviewer', description: 'Checks the completeness of evidence before reporting.', system_prompt: 'List missing evidence and identify which conclusions remain uncertain.' }
  await name.fill(changed.name)
  await description.fill(changed.description)
  await prompt.fill(changed.system_prompt)
  const navigation = window.locator('nav').filter({ has: window.getByRole('button', { name: 'Identity & Instructions', exact: true }) })
  await navigation.getByRole('button', { name: 'Advanced', exact: true }).click()
  await navigation.getByRole('button', { name: 'Identity & Instructions', exact: true }).click()
  await expect(name).toHaveValue(changed.name)
  await expect(prompt).toHaveValue(changed.system_prompt)
  expect((await readManagedPerson(window, person.id)).spec).toEqual(person.spec)
  await identity.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await readManagedPerson(window, person.id)).spec).toMatchObject(changed)
  expect((await readManagedPerson(window, other.id)).spec).toEqual(other.spec)

  const reopened = await managementApp.restart()
  await openManagedPersonSettings(reopened, changed.name)
  await expect(reopened.locator('#settings-group-identity input[type="text"]').first()).toHaveValue(changed.name)
  await expect(reopened.locator('#settings-group-identity input[type="text"]').nth(1)).toHaveValue(changed.description)
  await expect(reopened.locator('#settings-group-identity textarea')).toHaveValue(changed.system_prompt)
  expect((await readManagedPerson(reopened, other.id)).spec).toEqual(other.spec)
})

test('invalid identity edits report validation errors without replacing the saved person', managementAcceptance('people.settings.validation'), async ({ window }) => {
  const person = await seedManagedPerson(window, 'Validated reviewer')
  await openManagedPersonSettings(window, person.spec.name)
  const identity = window.locator('#settings-group-identity')
  const name = identity.locator('input[type="text"]').first()
  const description = identity.locator('input[type="text"]').nth(1)
  await name.fill('   ')
  await identity.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(identity.getByText('App name is required', { exact: true })).toBeVisible()
  expect((await readManagedPerson(window, person.id)).spec).toEqual(person.spec)
  await name.fill(person.spec.name)
  await description.fill('   ')
  await identity.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(identity.getByText('Description is required', { exact: true })).toBeVisible()
  expect((await readManagedPerson(window, person.id)).spec).toEqual(person.spec)
  await identity.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(name).toHaveValue(person.spec.name)
  await expect(description).toHaveValue(person.spec.description!)
})

test.describe('retained digital-human history', () => {
  test.use({ seedPersonChat: true })

  test('uninstall can be cancelled and confirmed, retaining history and files through restart and reinstall', managementAcceptance('people.settings.retire'), async ({ managementApp, window }) => {
    const chat = managementApp.personChat
    if (!chat) throw new Error('The retained-history precondition was not seeded')
    const output = join(dirname(dirname(chat.transcriptPath)), 'retained-output.txt')
    writeFileSync(output, 'Keep this generated output when the person is uninstalled.\n')
    const history = readFileSync(chat.transcriptPath, 'utf8')
    const other = await seedManagedPerson(window, 'Retained control reviewer')
    const original = await readManagedPerson(window, chat.appId)
    const confirmation = await uninstallPerson(window, chat.name)
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await readManagedPerson(window, chat.appId)).status).toBe(original.status)
    await window.getByRole('button', { name: 'More', exact: true }).click()
    await window.getByRole('button', { name: 'Uninstall', exact: true }).click()
    await confirmation.getByRole('button', { name: 'Uninstall', exact: true }).click()
    await expect(window.getByText('This app has been uninstalled', { exact: true })).toBeVisible()
    await expect.poll(async () => (await readManagedPerson(window, chat.appId)).status).toBe('uninstalled')
    expect(readFileSync(chat.transcriptPath, 'utf8')).toBe(history)
    expect(readFileSync(output, 'utf8')).toBe('Keep this generated output when the person is uninstalled.\n')
    expect((await readManagedPerson(window, other.id)).status).toBe(other.status)

    const reopened = await managementApp.restart()
    expect((await readManagedPerson(reopened, chat.appId)).status).toBe('uninstalled')
    await navigateToApps(reopened)
    await reopened.getByRole('textbox', { name: 'Search digital humans', exact: true }).fill(chat.name)
    await reopened.getByRole('button', { name: /^Removed/ }).click()
    await reopened.getByRole('button', { name: chat.name, exact: true }).click()
    await expect(reopened.getByText('This app has been uninstalled', { exact: true })).toBeVisible()
    await reopened.getByRole('button', { name: 'Reinstall App', exact: true }).click()
    await expect.poll(async () => (await readManagedPerson(reopened, chat.appId)).status).toBe('active')
    expect(readFileSync(chat.transcriptPath, 'utf8')).toBe(history)
    expect(readFileSync(output, 'utf8')).toBe('Keep this generated output when the person is uninstalled.\n')
    expect((await readManagedPerson(reopened, other.id)).spec).toEqual(other.spec)
  })
})

test('permanent removal needs its own confirmation and leaves another person and its files intact', managementAcceptance('people.settings.purge'), async ({ managementApp, window }) => {
  const person = await seedManagedPerson(window, 'Permanently removed reviewer')
  const other = await seedManagedPerson(window, 'Unrelated retained reviewer')
  const paths = await window.evaluate(async ids => {
    const api = (window as unknown as { halo: HaloAPI }).halo
    const values = await Promise.all(ids.map(id => api.appGetDataPath(id)))
    return values.map(value => {
      if (!value.success || !value.data) throw new Error('Could not resolve the fixture person data directory')
      return value.data.path
    })
  }, [person.id, other.id])
  for (const directory of paths) {
    const withinProfile = relative(managementApp.profile, directory)
    expect(withinProfile.length).toBeGreaterThan(0)
    expect(isAbsolute(withinProfile) || withinProfile === '..' || withinProfile.startsWith(`..${sep}`)).toBe(false)
    mkdirSync(directory, { recursive: true })
  }
  const removedFile = join(paths[0], 'removed-output.txt')
  const keptFile = join(paths[1], 'kept-output.txt')
  writeFileSync(removedFile, 'This fixture belongs to the permanently removed person.\n')
  writeFileSync(keptFile, 'This fixture belongs to the unrelated retained person.\n')
  const confirmation = await uninstallPerson(window, person.spec.name)
  await confirmation.getByRole('button', { name: 'Uninstall', exact: true }).click()
  await expect(window.getByText('This app has been uninstalled', { exact: true })).toBeVisible()
  await window.getByRole('button', { name: 'Delete Permanently', exact: true }).click()
  await expect(window.getByText('This will permanently delete the app and all its data. This action cannot be undone.', { exact: true })).toBeVisible()
  await window.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await readManagedPerson(window, person.id)).status).toBe('uninstalled')
  expect(existsSync(removedFile)).toBe(true)
  await window.getByRole('button', { name: 'Delete Permanently', exact: true }).click()
  await window.getByRole('button', { name: 'Yes, Delete Permanently', exact: true }).click()
  await expect.poll(async () => (await listManagedPeople(window)).some(item => item.id === person.id)).toBe(false)
  await expect.poll(() => existsSync(paths[0])).toBe(false)
  expect((await readManagedPerson(window, other.id)).spec).toEqual(other.spec)
  expect(readFileSync(keptFile, 'utf8')).toBe('This fixture belongs to the unrelated retained person.\n')
  const reopened = await managementApp.restart()
  expect((await listManagedPeople(reopened)).some(item => item.id === person.id)).toBe(false)
  expect(existsSync(paths[0])).toBe(false)
  expect((await readManagedPerson(reopened, other.id)).spec).toEqual(other.spec)
  expect(readFileSync(keptFile, 'utf8')).toBe('This fixture belongs to the unrelated retained person.\n')
})
