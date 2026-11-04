import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillListQuery } from '../../../src/shared/types/skills'
import { test, expect, skillUpgradeAcceptance } from '../fixtures/acceptance-skill-server'
import { skillImport } from '../fixtures/acceptance-skills'
import { waitForHomePage } from '../fixtures/helpers'

test.describe.configure({ retries: 0 })
test.use({ useScriptedModel: false })

test('all workspaces preserves explicit loading and opens the correct workspace detail', skillUpgradeAcceptance('capabilities.skill-library-server.all-workspaces'), async ({ skillServer: server }, info) => {
  const spaces: Array<{ id: string; name: string }> = []
  for (const name of ['First skill project', 'Second skill project']) {
    const path = join(server.profile, 'tmp', name.replaceAll(' ', '-'))
    mkdirSync(path)
    spaces.push(await server.request<{ id: string; name: string }>('/api/spaces', { name, icon: 'folder', customPath: path }))
  }
  await server.request('/api/skills/import', skillImport(spaces[0].id, 'local-project-workflow', 'Instructions from the first workspace.'))
  const page = server.page
  await page.reload()
  await waitForHomePage(page)
  await page.locator('nav').getByRole('button', { name: 'Digital Humans', exact: true }).click()
  await page.getByRole('button', { name: 'Capability library', exact: true }).click()
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Refresh skills', exact: true })).toBeEnabled()
  const queries: SkillListQuery[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/skills/list') queries.push(request.postDataJSON() as SkillListQuery)
  })
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('all')
  const first = page.getByRole('region', { name: spaces[0].name, exact: true })
  const second = page.getByRole('region', { name: spaces[1].name, exact: true })
  await expect(first.getByText('Skills have not been loaded for this workspace.', { exact: true })).toBeVisible()
  await expect(second.getByText('Skills have not been loaded for this workspace.', { exact: true })).toBeVisible()
  expect(queries).toEqual([])
  await first.getByRole('button', { name: 'Load skills', exact: true }).click()
  await expect(first.getByRole('heading', { name: 'local-project-workflow', level: 3, exact: true })).toBeVisible()
  expect(queries.length).toBeGreaterThan(0)
  expect(queries.every(query => query.spaceId === spaces[0].id)).toBe(true)
  expect(queries.every(query => query.limit === 50)).toBe(true)
  const global = page.getByRole('region', { name: 'Global', exact: true })
  await global.getByRole('button', { name: 'Load skills', exact: true }).click()
  await expect(global.getByRole('heading', { name: 'legacy-active-evidence', level: 3, exact: true })).toBeVisible()
  await expect(first.getByRole('heading', { name: 'legacy-active-evidence', level: 3, exact: true })).toHaveCount(0)
  await expect(second.getByText('Skills have not been loaded for this workspace.', { exact: true })).toBeVisible()
  expect(queries.every(query => query.spaceId !== spaces[1].id)).toBe(true)
  await first.getByRole('heading', { name: 'local-project-workflow', level: 3, exact: true }).click()
  await expect(page.getByRole('heading', { name: 'local-project-workflow', level: 2, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change workspace', exact: true })).toHaveText(spaces[0].name)
  await expect(page.getByText('Instructions from the first workspace.', { exact: true })).toBeVisible()
  expect(queries.every(query => query.spaceId !== spaces[1].id)).toBe(true)
  await info.attach('explicit-workspace-queries', { body: JSON.stringify({ queries, spaces }), contentType: 'application/json' })
})
