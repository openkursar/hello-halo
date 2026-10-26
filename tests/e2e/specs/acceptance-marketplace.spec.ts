import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { RegistrySource } from '../../../src/shared/store/store-types'
import {
  test, expect, registryAcceptance, registryPerson, registrySkill, registryMcp,
  installedRegistryResources, queryRegistry, openRegistry, openRegistryDetail, openRegistryInstall, registryCard,
} from '../fixtures/acceptance-registry'
import { openManagedPersonSettings, readManagedPerson, seedManagedSpace } from '../fixtures/acceptance-management'
import { navigateToSettings } from '../fixtures/helpers'

test.setTimeout(120000)

const primary = 'acceptance-primary'
const secondary = 'acceptance-secondary'
const primaryName = 'Local evidence registry'
const secondaryName = 'Local companion registry'

async function installedResource(page: Page, slug: string): Promise<InstalledApp> {
  await expect.poll(async () => (await installedRegistryResources(page)).filter(app => app.spec.store?.slug === slug).length).toBe(1)
  return (await installedRegistryResources(page)).find(app => app.spec.store?.slug === slug)!
}

async function confirmInstall(page: Page, dialog: Locator, slug: string): Promise<InstalledApp> {
  await dialog.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  return installedResource(page, slug)
}

async function sources(page: Page): Promise<RegistrySource[]> {
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.storeGetRegistries())
  expect(result.success).toBe(true)
  return result.data as RegistrySource[]
}

test.describe('local multi-source browsing', () => {
  const people = Array.from({ length: 36 }, (_, index) => registryPerson(`evidence-${String(index + 1).padStart(2, '0')}`, `Evidence reviewer ${String(index + 1).padStart(2, '0')}`, {
    category: index % 2 ? 'content' : 'data', description: `Acceptance catalog record ${index + 1}.`,
  }))
  test.use({ registryCatalog: { sources: [
    { id: primary, name: primaryName, resources: people.slice(0, 20) },
    { id: secondary, name: secondaryName, resources: people.slice(20) },
  ] } })

  test('catalog filters, counts, pagination and selected details agree across two real registry sources', registryAcceptance('marketplace.discover.filter'), async ({ window, registry }) => {
    await openRegistry(window)
    const cards = window.locator('div[role="button"]').filter({ hasText: /Evidence reviewer \d{2}/ })
    await expect(cards).toHaveCount(30)
    await expect(window.getByRole('button', { name: /^All\s*36$/ })).toBeVisible()
    await window.getByRole('button', { name: 'Load more', exact: true }).click()
    await expect(cards).toHaveCount(36)
    await expect(window.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0)
    const data = window.getByRole('button', { name: /Data\s*18$/ })
    await expect(data).toHaveCount(1)
    await data.click()
    await expect(cards).toHaveCount(18)
    await expect(registryCard(window, people[0].entry.name)).toBeVisible()
    await expect(registryCard(window, people[1].entry.name)).toHaveCount(0)
    const search = window.getByPlaceholder('Search Digital Humans / Skills / MCP', { exact: true })
    await search.fill('reviewer 21')
    await expect(cards).toHaveCount(1)
    await openRegistryDetail(window, people[20].entry.name)
    await expect(window.getByRole('heading', { name: people[20].entry.name, exact: true })).toBeVisible()
    await expect(window.getByText(people[20].entry.description, { exact: true }).first()).toBeVisible()
    expect(registry.requests.some(request => request.path === `/${secondary}/${people[20].entry.path}/spec.yaml` && request.status === 200)).toBe(true)
    expect(registry.requests.some(request => request.path === `/${primary}/${people[20].entry.path}/spec.yaml`)).toBe(false)
  })
})

test.describe('partial registry availability', () => {
  const healthy = registryPerson('healthy-reviewer', 'Available reviewer')
  const returning = registryPerson('returning-reviewer', 'Returning reviewer')
  test.use({ registryCatalog: { sources: [
    { id: primary, name: primaryName, resources: [healthy] },
    { id: secondary, name: secondaryName, resources: [returning], unavailable: true },
  ] } })

  test('a failed source leaves healthy entries usable and refresh restores the recovered source', registryAcceptance('marketplace.discover.partial'), async ({ window, registry }) => {
    await openRegistry(window)
    await expect(registryCard(window, healthy.entry.name)).toBeVisible()
    await expect(registryCard(window, returning.entry.name)).toHaveCount(0)
    await expect.poll(() => registry.requests.some(request => request.path.startsWith(`/${secondary}/`) && request.status === 503)).toBe(true)
    await openRegistryDetail(window, healthy.entry.name)
    await expect(window.getByRole('button', { name: 'Install', exact: true })).toBeEnabled()
    registry.setUnavailable(secondary, false)
    await openRegistry(window)
    await window.getByTitle('Refresh', { exact: true }).click()
    await expect(registryCard(window, healthy.entry.name)).toBeVisible()
    await expect(registryCard(window, returning.entry.name)).toBeVisible()
    const catalog = await queryRegistry(window, { type: 'automation' })
    expect(catalog.total).toBe(2)
    expect(registry.requests.some(request => request.path === `/${secondary}/digital-humans.json` && request.status === 200)).toBe(true)
  })
})

test.describe('dependency installation recovery', () => {
  const skill = registrySkill('evidence-checklist', 'Evidence checklist')
  const person = registryPerson('dependent-reviewer', 'Dependent reviewer', { skills: [skill.entry.slug] })
  test.use({ registryCatalog: { sources: [
    { id: primary, name: primaryName, resources: [person] },
    { id: secondary, name: secondaryName, resources: [skill] },
  ] } })

  test('a failed skill transfer rolls back its parent and retry installs exactly one complete dependency chain', {
    annotation: [registryAcceptance('marketplace.install.dependencies').annotation, registryAcceptance('marketplace.install.failure').annotation],
  }, async ({ window, registry, registryApp }) => {
    await openRegistry(window)
    const dialog = await openRegistryInstall(window, person.entry.name)
    const failingPath = `/${secondary}/${skill.entry.path}/files/SKILL.md`
    registry.failNext(failingPath, 404)
    await dialog.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(dialog).toContainText('Failed to install required skills')
    await expect(dialog.getByRole('button', { name: 'Install', exact: true })).toBeEnabled()
    expect(registry.requests.some(request => request.path === failingPath && request.status === 404)).toBe(true)
    expect((await installedRegistryResources(window)).filter(app => [person.entry.slug, skill.entry.slug].includes(app.spec.store?.slug ?? ''))).toEqual([])

    const installed = await confirmInstall(window, dialog, person.entry.slug)
    const dependency = await installedResource(window, skill.entry.slug)
    expect(installed).toMatchObject({ status: 'active', spaceId: 'halo-temp', spec: { store: { registry_id: primary, slug: person.entry.slug } } })
    expect(dependency).toMatchObject({ status: 'active', spaceId: 'halo-temp', spec: { store: { registry_id: secondary, slug: skill.entry.slug }, skill_files: skill.files } })
    const available = await window.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appListAvailableSkills(id), installed.id)
    expect(available.success).toBe(true)
    const discovered = available.data?.filter(item => item.dirName === skill.entry.slug) ?? []
    expect(discovered).toHaveLength(1)
    const relativePath = relative(registryApp.profile, discovered[0].path)
    expect(isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)).toBe(false)
    for (const [file, contents] of Object.entries(skill.files!)) expect(readFileSync(join(discovered[0].path, file), 'utf8')).toBe(contents)
    const reopened = await registryApp.restart()
    expect((await installedResource(reopened, person.entry.slug)).id).toBe(installed.id)
    expect((await installedResource(reopened, skill.entry.slug)).id).toBe(dependency.id)
    const restoredAvailability = await reopened.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appListAvailableSkills(id), installed.id)
    expect(restoredAvailability.success).toBe(true)
    const restoredSkills = restoredAvailability.data?.filter(item => item.dirName === skill.entry.slug) ?? []
    expect(restoredSkills).toHaveLength(1)
    expect(restoredSkills[0].path).toBe(discovered[0].path)
    for (const [file, contents] of Object.entries(skill.files!)) expect(readFileSync(join(restoredSkills[0].path, file), 'utf8')).toBe(contents)
    await openManagedPersonSettings(reopened, person.entry.name)
    await expect(reopened.locator('#settings-group-identity textarea')).toHaveValue(person.spec.system_prompt as string)
  })
})

test.describe('installation choices and updates', () => {
  const person = registryPerson('configured-reviewer', 'Configured reviewer', {
    description: 'Author description version one.', prompt: 'Author instructions version one.',
    config: [{ key: 'review_scope', label: 'Review scope', type: 'string', required: true, placeholder: 'Enter the review scope' }],
  })
  test.use({ registryCatalog: { sources: [{ id: primary, name: primaryName, resources: [person] }] } })

  test('installation requires a workspace choice and required settings before persisting one instance', registryAcceptance('marketplace.install.configuration'), async ({ window, registryApp }) => {
    const workspace = await seedManagedSpace(window, 'Chosen installation workspace')
    await window.reload()
    await openRegistry(window)
    const dialog = await openRegistryInstall(window, person.entry.name)
    await dialog.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Select a workspace', exact: true })).toBeVisible()
    expect((await installedRegistryResources(window)).filter(app => app.spec.store?.slug === person.entry.slug)).toEqual([])
    await dialog.getByRole('button', { name: 'Select a workspace', exact: true }).click()
    await window.getByRole('button', { name: workspace.name, exact: true }).click()
    await dialog.getByRole('button', { name: 'Next', exact: true }).click()
    await dialog.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(dialog.getByText('Please complete the required fields', { exact: true })).toBeVisible()
    expect((await installedRegistryResources(window)).filter(app => app.spec.store?.slug === person.entry.slug)).toEqual([])
    await dialog.getByPlaceholder('Enter the review scope', { exact: true }).fill('Only the current workspace evidence')
    const installed = await confirmInstall(window, dialog, person.entry.slug)
    expect(installed).toMatchObject({ spaceId: workspace.id, userConfig: { review_scope: 'Only the current workspace evidence' } })
    const reopened = await registryApp.restart()
    expect(await installedResource(reopened, person.entry.slug)).toMatchObject({ id: installed.id, spaceId: workspace.id, userConfig: installed.userConfig })
  })

  test('update preview preserves user instructions and settings while adopting unchanged author fields', registryAcceptance('marketplace.install.update'), async ({ window, registry, registryApp }) => {
    await openRegistry(window)
    const install = await openRegistryInstall(window, person.entry.name)
    await install.getByRole('button', { name: 'Next', exact: true }).click()
    await install.getByPlaceholder('Enter the review scope', { exact: true }).fill('Preserve this selected scope')
    const installed = await confirmInstall(window, install, person.entry.slug)
    await openManagedPersonSettings(window, person.entry.name)
    const identity = window.locator('#settings-group-identity')
    const userPrompt = 'Keep my instruction to distinguish uncertain evidence.'
    await identity.locator('textarea').fill(userPrompt)
    await identity.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await readManagedPerson(window, installed.id)).spec).toMatchObject({ system_prompt: userPrompt })
    await window.locator('#settings-group-advanced').getByRole('button', { name: /Advanced/ }).click()
    await window.locator('#upgrade-strategy').selectOption('notify')
    await expect.poll(async () => (await readManagedPerson(window, installed.id)).upgradeStrategy).toBe('notify')
    const updated = registryPerson(person.entry.slug, person.entry.name, {
      version: '2.0.0', description: 'Author description version two.', prompt: 'Author instructions version two.', config: person.spec.config_schema as Array<Record<string, unknown>>,
    })
    registry.publish(primary, [updated])
    await openRegistry(window)
    await window.getByTitle('Refresh', { exact: true }).click()
    await openRegistryDetail(window, person.entry.name)
    await window.getByRole('button', { name: 'Update to v2.0.0', exact: true }).click()
    const upgrade = window.locator('.fixed.inset-0').filter({ has: window.getByRole('heading', { name: 'Update available', exact: true }) })
    await expect(upgrade).toContainText('System Prompt')
    await upgrade.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await readManagedPerson(window, installed.id)).spec.version).toBe('1.0.0')
    await window.getByRole('button', { name: 'Update to v2.0.0', exact: true }).click()
    await expect(upgrade).toContainText('System Prompt')
    await upgrade.getByRole('button', { name: /^Update in place/ }).click()
    await expect(upgrade).toHaveCount(0)
    await expect.poll(async () => (await readManagedPerson(window, installed.id)).spec).toMatchObject({ version: '2.0.0', description: updated.spec.description, system_prompt: userPrompt })
    expect((await readManagedPerson(window, installed.id)).userConfig).toEqual(installed.userConfig)
    const reopened = await registryApp.restart()
    expect(await installedResource(reopened, person.entry.slug)).toMatchObject({ id: installed.id, userConfig: installed.userConfig, spec: { version: '2.0.0', description: updated.spec.description, system_prompt: userPrompt } })
    await openManagedPersonSettings(reopened, person.entry.name)
    await expect(reopened.locator('#settings-group-identity textarea')).toHaveValue(userPrompt)
  })
})

test.describe('registry artifact identity', () => {
  const valid = registryPerson('verified-reviewer', 'Verified reviewer')
  const mismatched = structuredClone(valid)
  mismatched.spec.store = { slug: 'unrelated-reviewer', category: 'data', tags: ['acceptance'] }
  test.use({ registryCatalog: { sources: [{ id: primary, name: primaryName, resources: [mismatched] }] } })

  test('a mismatched package is rejected before installation and retry reads the corrected artifact', registryAcceptance('marketplace.install.identity'), async ({ window, registry }) => {
    await openRegistry(window)
    await openRegistryDetail(window, valid.entry.name)
    await expect(window.getByText('Failed to load app details', { exact: true })).toBeVisible()
    await expect(window.getByText(/Spec slug mismatch/)).toBeVisible()
    await expect(window.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0)
    expect((await installedRegistryResources(window)).filter(app => app.spec.store?.slug === valid.entry.slug)).toEqual([])
    registry.publish(primary, [valid])
    await window.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(window.getByRole('heading', { name: valid.entry.name, exact: true })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Install', exact: true })).toBeEnabled()
    expect(registry.requests.filter(request => request.path === `/${primary}/${valid.entry.path}/spec.yaml` && request.status === 200).length).toBeGreaterThanOrEqual(2)
    expect((await installedRegistryResources(window)).filter(app => app.spec.store?.slug === valid.entry.slug)).toEqual([])
  })
})

test.describe('registry source controls', () => {
  const owned = registryPerson('retained-install', 'Retained installation')
  const other = registryPerson('other-source', 'Other source reviewer')
  test.use({ registryCatalog: { sources: [
    { id: primary, name: primaryName, resources: [owned] },
    { id: secondary, name: secondaryName, resources: [other] },
  ] } })

  test('source disable, enable and removal persist without uninstalling an existing resource', registryAcceptance('marketplace.sources.manage'), async ({ window, registryApp }) => {
    await openRegistry(window)
    const dialog = await openRegistryInstall(window, owned.entry.name)
    const installed = await confirmInstall(window, dialog, owned.entry.slug)
    await navigateToSettings(window)
    const sourceSection = window.locator('#app-store')
    await sourceSection.scrollIntoViewIfNeeded()
    const sourceRow = sourceSection.locator('div.px-4.py-3').filter({ has: window.getByText(primaryName, { exact: true }) })
    await expect(sourceRow).toHaveCount(1)
    await expect(sourceRow.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    await sourceRow.getByRole('switch').click()
    await expect(sourceRow.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    await openRegistry(window)
    await expect(registryCard(window, other.entry.name)).toBeVisible()
    await expect(window.getByTitle('Refresh', { exact: true })).toBeEnabled()
    await expect(registryCard(window, owned.entry.name)).toHaveCount(0)
    let reopened = await registryApp.restart()
    expect((await sources(reopened)).find(source => source.id === primary)?.enabled).toBe(false)
    expect((await installedResource(reopened, owned.entry.slug)).id).toBe(installed.id)
    await navigateToSettings(reopened)
    const restoredSection = reopened.locator('#app-store')
    await restoredSection.scrollIntoViewIfNeeded()
    const restoredRow = restoredSection.locator('div.px-4.py-3').filter({ has: reopened.getByText(primaryName, { exact: true }) })
    await restoredRow.getByRole('switch').click()
    await expect(restoredRow.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    await openRegistry(reopened)
    await expect(registryCard(reopened, owned.entry.name)).toBeVisible()
    await navigateToSettings(reopened)
    await restoredSection.scrollIntoViewIfNeeded()
    await restoredRow.getByTitle('Remove registry', { exact: true }).click()
    await expect(restoredRow).toHaveCount(0)
    reopened = await registryApp.restart()
    expect((await sources(reopened)).some(source => source.id === primary)).toBe(false)
    expect((await sources(reopened)).some(source => source.id === secondary && source.enabled)).toBe(true)
    expect((await installedResource(reopened, owned.entry.slug)).id).toBe(installed.id)
    await openRegistry(reopened)
    await expect(registryCard(reopened, other.entry.name)).toBeVisible()
    await expect(reopened.getByTitle('Refresh', { exact: true })).toBeEnabled()
    await expect(registryCard(reopened, owned.entry.name)).toHaveCount(0)
    await openManagedPersonSettings(reopened, owned.entry.name)
    await expect(reopened.locator('#settings-group-identity textarea')).toHaveValue(owned.spec.system_prompt as string)
  })

  test('invalid and loopback registry URLs produce visible errors without registering or probing them', registryAcceptance('marketplace.sources.validation'), async ({ window, registry }) => {
    await navigateToSettings(window)
    const section = window.locator('#app-store')
    await section.scrollIntoViewIfNeeded()
    const before = await sources(window)
    await section.getByRole('button', { name: 'Add Registry', exact: true }).click()
    await section.getByPlaceholder('Registry name', { exact: true }).fill('Rejected source')
    const url = section.locator('label').filter({ hasText: /^URL\s*\*?$/ }).locator('..').getByRole('textbox')
    await expect(url).toHaveCount(1)
    await url.fill('not a registry url')
    await section.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(section.getByText('Please enter a valid URL', { exact: true })).toBeVisible()
    expect(await sources(window)).toEqual(before)
    await url.fill(`${registry.url}/rejected-source`)
    await section.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(section.getByText('Registry URL must point to a public host (loopback, private, and link-local addresses are not allowed)', { exact: true })).toBeVisible()
    expect(await sources(window)).toEqual(before)
    expect(registry.requests.some(request => request.path.startsWith('/rejected-source'))).toBe(false)
    await section.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(url).toHaveCount(0)
  })
})

test.describe('MCP catalog capability boundary', () => {
  const mcp = registryMcp('catalog-mcp', 'Catalog MCP example')
  test.use({ registryCatalog: { sources: [{ id: primary, name: primaryName, resources: [mcp] }] } })

  test('MCP details explain the manual installation path without exposing an unsupported store install action', registryAcceptance('marketplace.discover.mcp-guidance'), async ({ window, registry }) => {
    await openRegistry(window, 'MCP')
    await openRegistryDetail(window, mcp.entry.name)
    await expect(window.getByRole('heading', { name: mcp.entry.name, exact: true })).toBeVisible()
    const disabled = window.getByRole('button', { name: 'Coming Soon', exact: true })
    await expect(disabled).toBeDisabled()
    await expect(disabled).toHaveAttribute('title', 'MCP store install is coming soon. Use Manual Add to configure MCP servers.')
    await expect(window.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0)
    expect((await installedRegistryResources(window)).filter(app => app.spec.store?.slug === mcp.entry.slug)).toEqual([])
    expect(registry.requests.some(request => request.path === `/${primary}/${mcp.entry.path}/spec.yaml` && request.status === 200)).toBe(true)
  })
})
