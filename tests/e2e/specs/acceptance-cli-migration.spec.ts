import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { McpSpec } from '../../../src/shared/apps/spec-types'
import {
  test, expect, cliAcceptance, cliPanel, cliPaths, cliTree, writeCliFile,
  migrationRow, migrationApps, installMigrationControl,
} from '../fixtures/acceptance-cli-migration'

test.setTimeout(90000)

const skillPanelTitle = 'Migrate Skills from Claude CLI'
const mcpPanelTitle = 'Migrate MCP Servers from Claude CLI'

function skillFiles(profile: string, directory: string, name: string, marker: string) {
  writeCliFile(profile, join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Read local acceptance notes\nuser-invocable: true\n---\n\n${marker}\n`)
  writeCliFile(profile, join(directory, name, 'references', 'details.txt'), `${marker} — nested resource\n`)
  writeCliFile(profile, join(directory, name, 'assets', 'sample.bin'), Buffer.from([0, 255, 1, 2, ...Buffer.from(marker)]))
}

async function chooseAction(page: Page, panel: Locator, name: string, action: string, expectedDefault?: string) {
  const row = migrationRow(page, panel, name)
  await expect(row).toHaveCount(1)
  if (expectedDefault) await expect(row.locator('select')).toHaveValue(expectedDefault)
  await row.locator('select').selectOption(action)
  await expect(row.locator('select')).toHaveValue(action)
}

function resultRow(panel: Locator, name: string) {
  return panel.getByText(name, { exact: true }).locator('../..')
}

for (const action of ['skip', 'overwrite', 'rename'] as const) {
  test(`CLI skill migration applies ${action} without changing either source or unrelated files`, cliAcceptance('capabilities.migrate.skills', { action }), async ({ cliMigration }, testInfo) => {
    const { profile, window, paths } = cliMigration
    const source = join(paths.ccDefault, 'skills')
    const destination = join(paths.haloDefault, 'skills')
    const collision = 'migration-collision'
    const omitted = 'migration-unselected'
    const fresh = 'migration-new'
    const unrelated = 'migration-control'
    skillFiles(profile, source, collision, 'SOURCE_COLLISION')
    skillFiles(profile, source, omitted, 'SOURCE_NOT_SELECTED')
    skillFiles(profile, source, fresh, 'SOURCE_NEW')
    skillFiles(profile, destination, collision, 'DESTINATION_COLLISION')
    skillFiles(profile, destination, `${collision}-cc`, 'EXISTING_RENAMED_CONTROL')
    skillFiles(profile, destination, unrelated, 'UNRELATED_DESTINATION')
    const sourceBefore = cliTree(profile, source)
    const destinationBefore = cliTree(profile, destination)
    const collisionBefore = cliTree(profile, join(destination, collision))
    const renamedControl = cliTree(profile, join(destination, `${collision}-cc`))
    const unrelatedBefore = cliTree(profile, join(destination, unrelated))
    const panel = await cliPanel(window, skillPanelTitle)
    await panel.getByRole('button', { name: 'Scan', exact: true }).click()
    await expect(panel.locator('select')).toHaveCount(3)
    await expect(migrationRow(window, panel, collision).getByText('Already exists in Halo', { exact: true })).toBeVisible()
    expect(cliTree(profile, source)).toEqual(sourceBefore)
    expect(cliTree(profile, destination)).toEqual(destinationBefore)
    await chooseAction(window, panel, collision, action, 'skip')
    await chooseAction(window, panel, omitted, 'skip', 'overwrite')
    await chooseAction(window, panel, fresh, 'overwrite', 'overwrite')
    await panel.getByRole('button', { name: 'Migrate', exact: true }).click()
    const destinationName = action === 'rename' ? `${collision}-cc2` : collision
    const resultLabel = action === 'rename' ? `${collision} → ${destinationName}` : collision
    await expect(resultRow(panel, resultLabel).getByText(action === 'skip' ? 'Skipped' : action === 'rename' ? 'Renamed' : 'Migrated', { exact: true })).toBeVisible()
    await expect(resultRow(panel, omitted).getByText('Skipped', { exact: true })).toBeVisible()
    await expect(resultRow(panel, fresh).getByText('Migrated', { exact: true })).toBeVisible()
    const assertFiles = () => {
      expect(cliTree(profile, source)).toEqual(sourceBefore)
      expect(cliTree(profile, join(destination, destinationName))).toEqual(action === 'skip' ? collisionBefore : cliTree(profile, join(source, collision)))
      if (action === 'rename') expect(cliTree(profile, join(destination, collision))).toEqual(collisionBefore)
      expect(cliTree(profile, join(destination, `${collision}-cc`))).toEqual(renamedControl)
      expect(cliTree(profile, join(destination, unrelated))).toEqual(unrelatedBefore)
      expect(cliTree(profile, join(destination, omitted))).toEqual({})
      expect(cliTree(profile, join(destination, fresh))).toEqual(cliTree(profile, join(source, fresh)))
      const changed = new Set([collision, fresh, ...(action === 'rename' ? [destinationName] : [])])
      const controls = (tree: Record<string, string>) => Object.fromEntries(Object.entries(tree).filter(([path]) => !changed.has(path.split('/')[0])))
      expect(controls(cliTree(profile, destination))).toEqual(controls(destinationBefore))
    }
    assertFiles()
    const after = cliTree(profile, destination)
    const reopened = await cliMigration.restart()
    const restored = await cliPanel(reopened, skillPanelTitle)
    await restored.getByRole('button', { name: 'Scan', exact: true }).click()
    await expect(migrationRow(reopened, restored, collision).getByText('Already exists in Halo', { exact: true })).toBeVisible()
    await expect(migrationRow(reopened, restored, fresh).getByText('Already exists in Halo', { exact: true })).toBeVisible()
    assertFiles()
    expect(cliTree(profile, destination)).toEqual(after)
    await testInfo.attach('skill-migration-files', { body: JSON.stringify({ action, sourceBefore, destinationBefore, after }), contentType: 'application/json' })
  })
}

function importedConfig(url: string, marker: string) {
  return { type: 'http', url, headers: { 'X-Acceptance-Revision': marker }, env: { ACCEPTANCE_SETTING: marker } }
}

function assertImported(app: InstalledApp, name: string, url: string, marker: string) {
  expect(app).toMatchObject({
    specId: name, spaceId: null, status: 'active', userConfig: { ACCEPTANCE_SETTING: marker },
    spec: { type: 'mcp', name, mcp_server: { transport: 'streamable-http', command: url, headers: { 'X-Acceptance-Revision': marker } } },
  })
}

test('CLI MCP import cancels without changes and persists only the selected definition', cliAcceptance('capabilities.migrate.mcp'), async ({ cliMigration }, testInfo) => {
  const { window, profile, mcpUrl } = cliMigration
  const control = await installMigrationControl(window, 'migration-existing-connection', mcpUrl)
  const sourcePath = join(profile, '.claude.json')
  writeCliFile(profile, sourcePath, JSON.stringify({ mcpServers: {
    'migration-selected-connection': importedConfig(mcpUrl, 'selected'),
    'migration-unselected-connection': importedConfig(mcpUrl, 'unselected'),
    [control.specId]: importedConfig(mcpUrl, 'must-not-overwrite'),
  }, fixtureControl: { marker: 'unrelated-cli-setting' } }, null, 2))
  const sourceBefore = readFileSync(sourcePath)
  const before = await migrationApps(window)
  const panel = await cliPanel(window, mcpPanelTitle)
  const select = async () => {
    await panel.getByRole('button', { name: 'Scan', exact: true }).click()
    await expect(panel.locator('select')).toHaveCount(3)
    await chooseAction(window, panel, 'migration-selected-connection', 'overwrite', 'overwrite')
    await chooseAction(window, panel, 'migration-unselected-connection', 'skip', 'overwrite')
    await chooseAction(window, panel, control.specId, 'skip', 'skip')
    await expect(migrationRow(window, panel, control.specId).getByText('Already exists in Halo', { exact: true })).toBeVisible()
  }
  await select()
  expect(await migrationApps(window)).toEqual(before)
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Scan', exact: true })).toBeVisible()
  expect(await migrationApps(window)).toEqual(before)
  expect(readFileSync(sourcePath)).toEqual(sourceBefore)
  await select()
  await panel.getByRole('button', { name: 'Migrate', exact: true }).click()
  await expect(resultRow(panel, 'migration-selected-connection').getByText('Merged', { exact: true })).toBeVisible()
  for (const name of ['migration-unselected-connection', control.specId]) await expect(resultRow(panel, name).getByText('Skipped', { exact: true })).toBeVisible()
  const after = await migrationApps(window)
  const selected = after.filter(app => app.specId === 'migration-selected-connection')
  expect(selected).toHaveLength(1)
  assertImported(selected[0], 'migration-selected-connection', mcpUrl, 'selected')
  expect(after.filter(app => app.id !== selected[0].id)).toEqual(before)
  expect(readFileSync(sourcePath)).toEqual(sourceBefore)
  const reopened = await cliMigration.restart()
  expect(await migrationApps(reopened)).toEqual(after)
  expect(readFileSync(sourcePath)).toEqual(sourceBefore)
  const restored = await cliPanel(reopened, mcpPanelTitle)
  await restored.getByRole('button', { name: 'Scan', exact: true }).click()
  await expect(migrationRow(reopened, restored, selected[0].specId).getByText('Already exists in Halo', { exact: true })).toBeVisible()
  await testInfo.attach('mcp-import-records', { body: JSON.stringify({ before, after }), contentType: 'application/json' })
})

test('CLI MCP overwrite replaces the selected colliding definition while preserving other connections', cliAcceptance('capabilities.migrate.mcp-overwrite'), async ({ cliMigration }, testInfo) => {
  const { window, profile, mcpUrl } = cliMigration
  const target = await installMigrationControl(window, 'migration-replaced-connection', mcpUrl)
  await installMigrationControl(window, 'migration-unrelated-connection', mcpUrl)
  const sourcePath = join(profile, '.claude.json')
  writeCliFile(profile, sourcePath, JSON.stringify({ mcpServers: {
    [target.specId]: importedConfig(mcpUrl, 'replacement'),
    'migration-omitted-connection': importedConfig(mcpUrl, 'unselected'),
  } }, null, 2))
  const sourceBefore = readFileSync(sourcePath)
  const before = await migrationApps(window)
  const panel = await cliPanel(window, mcpPanelTitle)
  await panel.getByRole('button', { name: 'Scan', exact: true }).click()
  await expect(panel.locator('select')).toHaveCount(2)
  await chooseAction(window, panel, target.specId, 'skip', 'skip')
  await chooseAction(window, panel, 'migration-omitted-connection', 'skip', 'overwrite')
  await panel.getByRole('button', { name: 'Migrate', exact: true }).click()
  await expect(resultRow(panel, target.specId).getByText('Skipped', { exact: true })).toBeVisible()
  expect(await migrationApps(window)).toEqual(before)
  expect(readFileSync(sourcePath)).toEqual(sourceBefore)
  await panel.getByRole('button', { name: 'Scan Again', exact: true }).click()
  await panel.getByRole('button', { name: 'Scan', exact: true }).click()
  await chooseAction(window, panel, target.specId, 'overwrite', 'skip')
  await chooseAction(window, panel, 'migration-omitted-connection', 'skip', 'overwrite')
  await panel.getByRole('button', { name: 'Migrate', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Scan Again', exact: true })).toBeVisible()
  const after = await migrationApps(window)
  await testInfo.attach('mcp-overwrite-records', { body: JSON.stringify({ before, after, resultText: await panel.innerText() }), contentType: 'application/json' })
  await expect.soft(resultRow(panel, target.specId).getByText('Merged', { exact: true })).toBeVisible()
  const selected = after.filter(app => app.specId === target.specId)
  expect(selected).toHaveLength(1)
  expect.soft((selected[0].spec as McpSpec).mcp_server).toEqual({ transport: 'streamable-http', command: mcpUrl, headers: { 'X-Acceptance-Revision': 'replacement' } })
  expect.soft(selected[0].userConfig).toEqual({ ACCEPTANCE_SETTING: 'replacement' })
  expect(after.filter(app => app.specId !== target.specId)).toEqual(before.filter(app => app.id !== target.id))
  expect(readFileSync(sourcePath)).toEqual(sourceBefore)
  const reopened = await cliMigration.restart()
  const restored = await migrationApps(reopened)
  expect(restored).toEqual(after)
  const persisted = restored.filter(app => app.specId === target.specId)
  expect(persisted).toHaveLength(1)
  assertImported(persisted[0], target.specId, mcpUrl, 'replacement')
  expect(readFileSync(sourcePath)).toEqual(sourceBefore)
})

test('CLI shared-directory warning gates applying it and custom text paths survive restart', cliAcceptance('capabilities.migrate.config-directory'), async ({ cliMigration }) => {
  const { profile, window, paths } = cliMigration
  const custom = join(profile, 'custom CLI settings')
  writeCliFile(profile, join(paths.ccDefault, 'settings.json'), JSON.stringify({ fixtureMarker: 'CLI_SETTINGS_CONTROL' }))
  writeCliFile(profile, join(paths.haloDefault, 'directory-control.txt'), 'HALO_DIRECTORY_CONTROL\n')
  writeCliFile(profile, join(custom, 'settings.json'), JSON.stringify({ fixtureMarker: 'CUSTOM_SETTINGS_CONTROL' }))
  const sourceBefore = readFileSync(join(paths.ccDefault, 'settings.json'))
  const customBefore = readFileSync(join(custom, 'settings.json'))
  const haloControl = readFileSync(join(paths.haloDefault, 'directory-control.txt'))
  const persistedAgent = () => JSON.parse(readFileSync(join(profile, '.halo/config.json'), 'utf8')).agent as { configDirMode: string; customConfigDir?: string }
  const panel = await cliPanel(window, 'Config Directory')
  const effective = (panel: Locator) => panel.getByText('Current effective path:', { exact: true }).locator('..')
  await panel.locator('input[value="halo"]').check()
  await panel.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(effective(panel)).toHaveText(`Current effective path: ${paths.haloDefault}`)
  expect(persistedAgent().configDirMode).toBe('halo')
  const baseline = persistedAgent()
  const warning = window.getByText('High Risk: Shared Config', { exact: true }).locator('../..')
  await panel.locator('input[value="cc"]').click()
  await expect(warning).toBeVisible()
  await expect(panel.locator('input[value="cc"]')).not.toBeChecked()
  expect(persistedAgent()).toEqual(baseline)
  expect((await cliPaths(window)).current).toBe(paths.haloDefault)
  await warning.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(warning).toHaveCount(0)
  await expect(panel.locator('input[value="halo"]')).toBeChecked()
  expect(persistedAgent()).toEqual(baseline)
  await panel.locator('input[value="cc"]').click()
  await warning.getByRole('button', { name: 'Use Shared Config', exact: true }).click()
  await expect(panel.locator('input[value="cc"]')).toBeChecked()
  expect(persistedAgent()).toEqual(baseline)
  expect((await cliPaths(window)).current).toBe(paths.haloDefault)
  await panel.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(effective(panel)).toHaveText(`Current effective path: ${paths.ccDefault}`)
  expect(persistedAgent().configDirMode).toBe('cc')

  const reopened = await cliMigration.restart()
  const restored = await cliPanel(reopened, 'Config Directory')
  await expect(restored.locator('input[value="cc"]')).toBeChecked()
  await expect(effective(restored)).toHaveText(`Current effective path: ${paths.ccDefault}`)
  await restored.locator('input[value="custom"]').check()
  await restored.getByRole('textbox').fill(join(profile, 'does-not-exist'))
  await restored.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(restored.getByText(`Directory does not exist: ${join(profile, 'does-not-exist')}`, { exact: true })).toBeVisible()
  expect(persistedAgent().configDirMode).toBe('cc')
  expect((await cliPaths(reopened)).current).toBe(paths.ccDefault)
  await restored.getByRole('textbox').fill(custom)
  await restored.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(effective(restored)).toHaveText(`Current effective path: ${custom}`)
  expect(persistedAgent()).toMatchObject({ configDirMode: 'custom', customConfigDir: custom })
  const again = await cliMigration.restart()
  const final = await cliPanel(again, 'Config Directory')
  await expect(final.locator('input[value="custom"]')).toBeChecked()
  await expect(final.getByRole('textbox')).toHaveValue(custom)
  await expect(effective(final)).toHaveText(`Current effective path: ${custom}`)
  expect(readFileSync(join(paths.ccDefault, 'settings.json'))).toEqual(sourceBefore)
  expect(readFileSync(join(custom, 'settings.json'))).toEqual(customBefore)
  expect(readFileSync(join(paths.haloDefault, 'directory-control.txt'))).toEqual(haloControl)
})
