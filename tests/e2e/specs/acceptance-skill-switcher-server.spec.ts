import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import type { SkillCopy, SkillImportInput, SkillInventory, SkillListQuery, SkillSaveInput } from '../../../src/shared/types/skills'
import { test, expect, skillUpgradeAcceptance, type SkillServer } from '../fixtures/acceptance-skill-server'
import { ownedSkillFile, skillImport, skillMarkdown } from '../fixtures/acceptance-skills'
import { waitForHomePage } from '../fixtures/helpers'

test.describe.configure({ retries: 0 })
test.use({ useScriptedModel: false })
test.setTimeout(180000)

function card(page: Page, name: string): Locator {
  return page.locator('[role="button"]').filter({ has: page.getByRole('heading', { name, exact: true, level: 3 }) })
}

async function openLibrary(page: Page) {
  await page.locator('nav').getByRole('button', { name: 'Digital Humans', exact: true }).click()
  await page.getByRole('button', { name: 'Capability library', exact: true }).click()
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('')
  await expect(page.getByRole('button', { name: 'Refresh skills', exact: true })).toBeEnabled()
}

async function seed(server: SkillServer, name: string, description?: string) {
  const input = skillImport(null, name, `Read the ${name} instructions.`)
  if (description) {
    input.spec.description = description
    input.spec.skill_files!['SKILL.md'] = input.spec.skill_files!['SKILL.md'].replace(
      'description: Inspect isolated acceptance evidence', `description: ${description}`,
    )
  }
  await server.request('/api/skills/import', input)
}

function onlyCopy(inventory: SkillInventory, name: string): SkillCopy {
  const copies = inventory.groups.find(group => group.name === name)?.copies ?? []
  expect(copies).toHaveLength(1)
  return copies[0]
}

async function reloadAndOpen(page: Page, name: string) {
  await page.reload()
  await waitForHomePage(page)
  await openLibrary(page)
  await card(page, name).click()
  await expect(page.getByRole('heading', { name, exact: true, level: 2 })).toBeVisible()
}

async function replaceInstructions(page: Page, content: string) {
  const editor = page.locator('.cm-content[contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.click()
  await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText(content)
}

test('skill details retain sibling search, saved instructions, hover cards and persisted folded width without crowding narrow screens', skillUpgradeAcceptance('capabilities.skill-switcher-server.navigate'), async ({ skillServer: server }, info) => {
  const page = server.page
  const names = ['switcher-alpha', 'switcher-beta', 'switcher-gamma', 'switcher-delta']
  const description = 'Searchable sibling description only'
  for (const name of names) await seed(server, name, name === names[1] ? description : undefined)
  const inventory = await server.list()
  expect(inventory.groups.length).toBeGreaterThanOrEqual(8)
  const copies = names.map(name => onlyCopy(inventory, name))
  const original = await server.read({ spaceId: null, id: copies[0].id })
  const queries: SkillListQuery[] = []
  const saves: SkillSaveInput[] = []
  const imports: SkillImportInput[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path === '/api/skills/list') queries.push(request.postDataJSON() as SkillListQuery)
    if (path === '/api/skills/save') saves.push(request.postDataJSON() as SkillSaveInput)
    if (path === '/api/skills/import') imports.push(request.postDataJSON() as SkillImportInput)
  })

  await reloadAndOpen(page, names[0])
  queries.length = 0
  const sidebar = page.getByRole('navigation', { name: 'Skills', exact: true })
  await expect(sidebar).toBeVisible()
  await expect(sidebar.getByRole('button', { name: names[0], exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('button', { name: 'Capability library', exact: true })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveCount(0)
  await expect(sidebar.getByRole('textbox', { name: 'Search skills', exact: true })).toBeVisible()

  await test.step('Search descriptions on the server and switch directly to a sibling', async () => {
    const search = sidebar.getByRole('textbox', { name: 'Search skills', exact: true })
    await search.fill(description)
    await expect(sidebar.getByRole('button', { name: names[1], exact: true })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: names[0], exact: true })).toHaveCount(0)
    await expect(search).toHaveValue(description)
    await expect.poll(() => queries.some(query => query.q === description && query.spaceId === null && query.limit === 50)).toBe(true)
    await expect(page.getByRole('heading', { name: names[0], exact: true, level: 2 })).toBeVisible()
    await sidebar.getByRole('button', { name: names[1], exact: true }).click()
    await expect(page.getByRole('heading', { name: names[1], exact: true, level: 2 })).toBeVisible()
    await expect(page.getByText(`Read the ${names[1]} instructions.`, { exact: true })).toBeVisible()
    await expect(page.getByText(`Read the ${names[0]} instructions.`, { exact: true })).toHaveCount(0)
    await search.fill('')
    await expect(sidebar.getByRole('button', { name: names[0], exact: true })).toBeVisible()
  })

  const savedBody = 'Saved sibling instructions remain after switching away and back.'
  const savedContent = skillMarkdown(names[1], savedBody)
  await test.step('Save explicitly before switching and read the same saved file on return', async () => {
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await replaceInstructions(page, savedContent)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const confirmation = page.getByRole('alertdialog', { name: 'Save shared resource changes?', exact: true })
    await confirmation.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect(page.getByText(savedBody, { exact: true })).toBeVisible()
    await sidebar.getByRole('button', { name: names[0], exact: true }).click()
    await expect(page.getByRole('heading', { name: names[0], exact: true, level: 2 })).toBeVisible()
    await expect(page.getByText(savedBody, { exact: true })).toHaveCount(0)
    await sidebar.getByRole('button', { name: names[1], exact: true }).click()
    await expect(page.getByText(savedBody, { exact: true })).toBeVisible()
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({ ref: { spaceId: null, id: copies[1].id }, content: savedContent })
    expect((await server.read({ spaceId: null, id: copies[1].id })).content).toBe(savedContent)
    expect(readFileSync(ownedSkillFile(server.profile, copies[1]), 'utf8')).toBe(savedContent)
    expect((await server.read({ spaceId: null, id: copies[0].id })).content).toBe(original.content)
  })

  await test.step('Fold to icons, inspect the hover card and expand before dragging the existing resize edge', async () => {
    await sidebar.getByRole('button', { name: 'Collapse', exact: true }).click()
    await expect(sidebar.getByRole('button', { name: 'Expand', exact: true })).toBeVisible()
    await expect(sidebar.getByRole('textbox', { name: 'Search skills', exact: true })).toHaveCount(0)
    const icon = sidebar.getByRole('button', { name: names[2], exact: true })
    await expect(icon).toBeVisible()
    await icon.hover()
    await expect(icon).toHaveAttribute('aria-describedby', /.+/)
    const tooltipId = await icon.getAttribute('aria-describedby')
    const hover = page.locator(`[role="tooltip"][id="${tooltipId}"]`)
    await expect(hover).toContainText(names[2])
    await expect(hover).toContainText('Inspect isolated acceptance evidence')
    await icon.click()
    await expect(page.getByRole('heading', { name: names[2], exact: true, level: 2 })).toBeVisible()
    await sidebar.getByRole('button', { name: 'Expand', exact: true }).click()
    const bounds = await sidebar.boundingBox()
    const handle = await sidebar.getByTitle('Drag to resize width', { exact: true }).boundingBox()
    expect(bounds).not.toBeNull()
    expect(handle).not.toBeNull()
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 40)
    await page.mouse.down()
    await page.mouse.move(bounds!.x + 280, handle!.y + 40, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(280)
    await page.screenshot({ path: info.outputPath('skill-sidebar-expanded.png') })
  })

  await test.step('Reload and reopen to prove persisted width and folded state through the real preference store', async () => {
    await reloadAndOpen(page, names[0])
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(280)
    await sidebar.getByRole('button', { name: 'Collapse', exact: true }).click()
    await reloadAndOpen(page, names[0])
    await expect(sidebar.getByRole('button', { name: 'Expand', exact: true })).toBeVisible()
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(56)
    await sidebar.getByRole('button', { name: 'Expand', exact: true }).click()
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(280)
  })

  await test.step('Hide the desktop switcher below md without squeezing the skill or losing its back action', async () => {
    for (const width of [767, 375, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(sidebar).toBeHidden()
      await expect(page.getByRole('heading', { name: names[0], exact: true, level: 2 })).toBeVisible()
      await expect(page.getByText(`Read the ${names[0]} instructions.`, { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Back to capability library', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
      if (width < 640) {
        const title = await page.getByRole('heading', { name: names[0], exact: true, level: 2 }).boundingBox()
        const scope = await page.getByRole('button', { name: 'Change workspace', exact: true }).boundingBox()
        const action = await page.getByRole('button', { name: 'Use', exact: true }).boundingBox()
        expect(title!.height).toBeLessThan(30)
        expect(scope!.height).toBeLessThan(35)
        expect(action!.y).toBeGreaterThanOrEqual(scope!.y + scope!.height)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
    await page.screenshot({ path: info.outputPath('skill-sidebar-narrow.png') })
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(sidebar).toBeVisible()
  })
  expect(imports).toHaveLength(0)
  const detailQueries = queries.filter(query => query.limit === 50)
  expect(detailQueries.length).toBeGreaterThan(0)
  expect(queries.every(query => (query.limit ?? 50) <= 100)).toBe(true)
  await info.attach('skill-switcher-navigation', {
    body: JSON.stringify({ queries, saves, imports, persisted: await page.evaluate(() => JSON.parse(localStorage.getItem('halo-apps-page') ?? '{}')) }, null, 2),
    contentType: 'application/json',
  })
})

test('skill sibling pages stay bounded and search reaches skills outside the current page', skillUpgradeAcceptance('capabilities.skill-switcher-server.pages'), async ({ skillServer: server }, info) => {
  const page = server.page
  const names = Array.from({ length: 55 }, (_, index) => `sidebar-page-${String(index).padStart(2, '0')}`)
  for (const name of names) await seed(server, name)
  await page.reload()
  await waitForHomePage(page)
  await openLibrary(page)
  await card(page, names[0]).click()
  const sidebar = page.getByRole('navigation', { name: 'Skills', exact: true })
  await expect(sidebar).toBeVisible()
  await expect(sidebar.getByRole('button', { name: names[0], exact: true })).toBeVisible()
  const firstPage = await server.request<SkillInventory>('/api/skills/list', { spaceId: null, offset: 0, limit: 50 })
  const secondPage = await server.request<SkillInventory>('/api/skills/list', { spaceId: null, offset: 50, limit: 50 })
  expect(firstPage.groups).toHaveLength(50)
  const target = secondPage.groups.find(group => group.name.startsWith('sidebar-page-'))!
  expect(target).toBeDefined()
  const queries: SkillListQuery[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/skills/list') queries.push(request.postDataJSON() as SkillListQuery)
  })
  await expect(sidebar.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled()
  await expect(sidebar.getByRole('button', { name: target.displayName, exact: true })).toHaveCount(0)
  await sidebar.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(sidebar.getByRole('button', { name: target.displayName, exact: true })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
  await sidebar.getByRole('button', { name: target.displayName, exact: true }).click()
  await expect(page.getByRole('heading', { name: target.displayName, exact: true, level: 2 })).toBeVisible()
  await expect(page.getByText(`Read the ${target.name} instructions.`, { exact: true })).toBeVisible()
  await sidebar.getByRole('button', { name: 'Previous', exact: true }).click()
  await expect(sidebar.getByRole('button', { name: names[0], exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: target.displayName, exact: true, level: 2 })).toBeVisible()
  await sidebar.getByRole('textbox', { name: 'Search skills', exact: true }).fill(target.name)
  await expect(sidebar.getByRole('button', { name: target.displayName, exact: true })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: names[0], exact: true })).toHaveCount(0)
  await expect(sidebar.getByRole('textbox', { name: 'Search skills', exact: true })).toHaveValue(target.name)
  await expect.poll(() => queries.some(query => query.q === target.name && query.offset === 0)).toBe(true)
  await expect(sidebar.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0)
  expect(queries.some(query => query.offset === 50 && query.limit === 50)).toBe(true)
  expect(queries.every(query => query.spaceId === null && (query.limit ?? 50) <= 100)).toBe(true)
  await page.screenshot({ path: info.outputPath('skill-sidebar-search-outside-page.png') })
  await info.attach('skill-switcher-page-queries', { body: JSON.stringify(queries, null, 2), contentType: 'application/json' })
})
