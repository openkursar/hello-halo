import type { SkillInventory, SkillRef } from '../../../src/shared/types/skills'
import { test, expect, skillUpgradeAcceptance } from '../fixtures/acceptance-skill-server'
import { skillImport } from '../fixtures/acceptance-skills'
import { openManagedPersonSettings } from '../fixtures/acceptance-management'
import { waitForHomePage } from '../fixtures/helpers'

test.describe.configure({ retries: 0 })
test.use({ useScriptedModel: false })

test('a person shows the known skill total and connection names when instructions are expanded', skillUpgradeAcceptance('people.skill-context.details'), async ({ skillServer: server }, info) => {
  const home = await server.request<{ id: string }>('/api/spaces/halo')
  const person = 'Skill Details Reader'
  await server.request('/api/apps/install', { spaceId: home.id, spec: {
    spec_version: '1.0', type: 'automation', name: person, author: 'Acceptance', version: '1.0.0',
    description: 'Inspect an isolated skills panel.', system_prompt: 'Use only the supplied test references.',
    subscriptions: [], requires: {}, permissions: [], config_schema: [],
  } })
  const input = skillImport(home.id, 'connections-reference', 'Use the declared connections to prepare the report.')
  input.spec.requires = { mcps: [{ id: 'github' }, { id: 'slack' }] }
  await server.request('/api/skills/import', input)
  const expected = await server.request<SkillInventory>('/api/skills/list', { spaceId: home.id, limit: 50 })
  const selected = expected.groups.find(group => group.name === input.spec.name)!
  expect(selected).toBeDefined()
  await server.page.reload()
  await waitForHomePage(server.page)
  const reads: SkillRef[] = []
  server.page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/skills/read') reads.push(request.postDataJSON() as SkillRef)
  })
  await openManagedPersonSettings(server.page, person)
  const tools = server.page.locator('#settings-group-tools')
  await tools.scrollIntoViewIfNeeded()
  await expect(tools.getByRole('heading', { name: new RegExp(`^Skills\\s*\\(${expected.total}\\)$`) })).toBeVisible()
  const expand = tools.getByRole('button', { name: input.spec.name, exact: true })
  await expect(expand).toHaveAttribute('aria-expanded', 'false')
  expect(reads).toEqual([])
  await expect(tools.getByRole('button', { name: 'Open skill folder', exact: true })).toHaveCount(0)
  await expand.click()
  await expect(tools.getByText('Required connections: github, slack', { exact: true })).toBeVisible()
  const body = tools.getByText('Use the declared connections to prepare the report.', { exact: true })
  await expect(body).toBeVisible()
  const open = tools.getByRole('button', { name: 'Open skill detail', exact: true })
  await expect(open).toBeVisible()
  expect((await body.boundingBox())!.y).toBeLessThan((await open.boundingBox())!.y)
  expect(reads).toEqual([{ id: selected.effectiveId!, spaceId: home.id }])
  await info.attach('person-skill-detail-reads', { body: JSON.stringify({ reads, total: expected.total, names: ['github', 'slack'] }), contentType: 'application/json' })
  await server.page.screenshot({ path: info.outputPath('person-skill-details.png') })
})
