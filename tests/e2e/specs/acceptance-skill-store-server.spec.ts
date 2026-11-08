import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'
import type { Page } from '@playwright/test'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { RegistrySource, UpdateInfo } from '../../../src/shared/store/store-types'
import type { SkillCopy, SkillDetail } from '../../../src/shared/types/skills'
import { test as serverTest, expect, skillUpgradeAcceptance, type SkillServer } from '../fixtures/acceptance-skill-server'
import { registrySkill } from '../fixtures/acceptance-registry'
import { ownedSkillFile, readSkillPackage } from '../fixtures/acceptance-skills'

const registryId = 'acceptance-maintained-skills'
const test = serverTest.extend<{ registry: Awaited<ReturnType<typeof startRegistry>> }>({
  registry: async ({}, use, info) => {
    const registry = await startRegistry()
    try { await use(registry) }
    finally {
      await registry.close()
      await info.attach('local-store-requests', { body: JSON.stringify(registry.requests), contentType: 'application/json' })
    }
  },
  skillRegistries: async ({ registry }, use) => {
    const disabled = ['official', 'mcp-official', 'smithery', 'claude-skills', 'skillhub'].map(id => ({ id, name: id, url: `${registry.url}/disabled/${id}`, enabled: false, sourceType: 'halo' as const }))
    await use([...disabled, { id: registryId, name: 'Local maintained skill registry', url: registry.url, enabled: true, sourceType: 'halo' }])
  },
})
test.describe.configure({ retries: 0 })
test.use({ useScriptedModel: false })
test.setTimeout(180000)

const slug = 'maintained-store-evidence'
const name = 'Maintained evidence skill'
const customBody = 'Keep my saved instructions until I explicitly replace the package.'

function release(version: string) {
  const resource = registrySkill(slug, name, version)
  const body = `Author instructions version ${version}.`
  const files: Record<string, string> = {
    ...resource.files,
    'SKILL.md': resource.files!['SKILL.md'].replace('Read references/checklist.md before drawing a conclusion.', body),
    ...(version === '1.0.0' ? { 'references/obsolete.md': 'Remove this only after explicit replacement.\n' } : { 'references/current.md': `New supporting content for version ${version}.\n` }),
  }
  return { ...resource, spec: { ...resource.spec, skill_files: Object.keys(files) }, files, body }
}

async function startRegistry() {
  const first = release('1.0.0')
  const second = release('2.0.0')
  const third = release('3.0.0')
  let current = first
  const requests: Array<{ path: string; status: number; version: string }> = []
  const artifacts = new Map<string, string>()
  for (const resource of [first, second, third]) {
    artifacts.set(`/${resource.entry.path}/spec.yaml`, stringify(resource.spec))
    for (const [file, content] of Object.entries(resource.files)) artifacts.set(`/${resource.entry.path}/files/${file}`, content)
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const index = ['index.json', 'digital-humans.json', 'skills.json', 'mcps.json'].includes(path.slice(1))
    const body = index ? JSON.stringify({ version: 1, generated_at: '2026-01-01T00:00:00.000Z', source: 'local-skill-evidence', apps: ['/index.json', '/skills.json'].includes(path) ? [current.entry] : [] }) : artifacts.get(path)
    const status = request.method !== 'GET' ? 405 : body === undefined ? 404 : 200
    requests.push({ path, status, version: current.entry.version })
    response.writeHead(status, { 'content-type': index ? 'application/json' : 'text/plain; charset=utf-8' })
    response.end(status === 200 ? body : 'Local registry resource unavailable')
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The registry must bind an ephemeral loopback TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`, first, second, third, requests,
    publish(newer = false) { current = newer ? third : second },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

async function openLibrary(page: Page) {
  await page.locator('nav').getByRole('button', { name: 'Digital Humans', exact: true }).click()
  await page.getByRole('button', { name: 'Capability library', exact: true }).click()
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('')
  await expect(page.getByRole('button', { name: 'Refresh skills', exact: true })).toBeEnabled()
}

function card(page: Page) {
  return page.locator('[role="button"]').filter({ has: page.getByRole('heading', { name, exact: true, level: 3 }) })
}

async function controls(server: SkillServer) {
  const inventory = await server.list()
  const packages = server.records.filter(record => !['uninstalled', 'deleted'].includes(record.kind)).map(record => {
    const copies = inventory.groups.find(group => group.name === record.name)?.copies ?? []
    expect(copies).toHaveLength(1)
    return { id: copies[0].id, enabled: copies[0].enabled, path: copies[0].path, package: readSkillPackage(server.profile, copies[0]) }
  })
  return { rows: server.rows(), packages, absent: server.records.filter(record => ['uninstalled', 'deleted'].includes(record.kind)).map(record => ({ id: record.id, exists: existsSync(record.destination) })) }
}

function assertPackage(server: SkillServer, detail: SkillDetail, files: Record<string, string>) {
  const root = dirname(ownedSkillFile(server.profile, detail.copy))
  const names = Object.keys(files).sort()
  expect(detail.files.map(file => file.path).sort()).toEqual(names)
  const disk: string[] = []
  function walk(relative = '') {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path)
      else disk.push(path)
    }
  }
  walk()
  expect(disk.sort()).toEqual(names)
  expect(detail.spec.skill_files).toEqual(files)
  expect(detail.content).toBe(files['SKILL.md'])
  for (const [file, content] of Object.entries(files)) expect(readFileSync(join(root, file), 'utf8')).toBe(content)
}

test('install a maintained store skill and keep or replace its saved package through the real UI', skillUpgradeAcceptance('marketplace.skill-server.install-update'), async ({ skillServer: server, registry }, info) => {
  let page = server.page
  const baseline = await controls(server)
  const mutations: Array<{ path: string; body: unknown }> = []
  const snapshots: unknown[] = []
  const installPath = `/api/store/apps/${slug}/install`
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && (path === installPath || path === '/api/skills/save' || path === '/api/skills/set-enabled' || /^\/api\/store\/updates\/[^/]+\/apply$/.test(path))) {
      mutations.push({ path, body: request.postDataJSON() })
    }
  })
  try {
    const enabled = (await server.request<RegistrySource[]>('/api/store/registries')).filter(item => item.enabled)
    expect(enabled).toHaveLength(1)
    const source = enabled[0]
    expect(source).toMatchObject({ id: registryId, url: registry.url, sourceType: 'halo' })
    await server.request('/api/store/refresh', {})

    await openLibrary(page)
    await page.getByRole('button', { name: 'Install from Marketplace', exact: true }).click()
    await page.getByText(name, { exact: true }).locator('xpath=ancestor::div[@role="button"][1]').click()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const install = page.locator('.fixed.inset-0').filter({ has: page.getByRole('heading', { name, level: 2, exact: true }) })
    await install.getByRole('button', { name: 'Select a workspace', exact: true }).click()
    await page.getByRole('button', { name: 'Global (all workspaces)', exact: true }).click()
    await install.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(install).toHaveCount(0)
    const installed = (await server.request<InstalledApp[]>('/api/apps?type=skill')).filter(app => app.spec.store?.slug === slug)
    expect(installed).toHaveLength(1)
    const appId = installed[0].id
    const readApp = () => server.request<InstalledApp>(`/api/apps/${appId}`)
    const copies = (await server.list()).groups.find(group => group.name === slug)?.copies ?? []
    expect(copies).toHaveLength(1)
    const copy: SkillCopy = copies[0]
    const ref = { id: copy.id, spaceId: null }
    expect(copy).toMatchObject({ appId, source: 'store', scope: 'global', enabled: true, spaceId: null })
    expect(ownedSkillFile(server.profile, copy)).toBe(join(server.profile, '.agents/skills', slug, 'SKILL.md'))
    expect(existsSync(join(server.profile, '.halo/skills'))).toBe(false)
    expect(installed[0]).toMatchObject({ status: 'active', spaceId: null, spec: { version: '1.0.0', store: { slug, registry_id: source.id, install_source: 'store' } } })
    expect(mutations.filter(item => item.path === installPath)).toEqual([{ path: installPath, body: { spaceId: null } }])
    assertPackage(server, await server.read(ref), registry.first.files)
    snapshots.push({ stage: 'installed', app: installed[0], detail: await server.read(ref) })

    await openLibrary(page)
    await card(page).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const editor = page.locator('.cm-content[contenteditable="true"]')
    const draft = registry.first.files['SKILL.md'].replace(registry.first.body, customBody)
    await editor.click()
    await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText(draft)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const save = page.getByRole('alertdialog', { name: 'Save shared resource changes?', exact: true })
    await expect(save).toContainText('Supporting files will be kept.')
    expect(mutations.filter(item => item.path === '/api/skills/save')).toEqual([])
    assertPackage(server, await server.read(ref), registry.first.files)
    await save.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(editor).toContainText(customBody)
    expect(mutations.filter(item => item.path === '/api/skills/save')).toEqual([])
    assertPackage(server, await server.read(ref), registry.first.files)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await save.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await expect(page.getByText(customBody, { exact: true })).toBeVisible()
    const customized = { ...registry.first.files, 'SKILL.md': draft }
    assertPackage(server, await server.read(ref), customized)
    expect(await readApp()).toMatchObject({ spec: { version: '1.0.0' }, userOverrides: { skill: { customized: true } } })
    expect(mutations.filter(item => item.path === '/api/skills/save')).toHaveLength(1)
    await page.getByRole('button', { name: 'Disable', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled()
    expect((await readApp()).status).toBe('paused')
    expect((await server.read(ref)).copy).toMatchObject({ enabled: false, availability: 'disabled' })
    expect(mutations.filter(item => item.path === '/api/skills/set-enabled')).toEqual([{ path: '/api/skills/set-enabled', body: { ref, enabled: false } }])
    snapshots.push({ stage: 'saved-disabled', app: await readApp(), detail: await server.read(ref) })

    registry.publish()
    await server.request('/api/store/refresh', {})
    const check = await server.request<{ autoApplied: number }>('/api/store/updates/check-now', {})
    expect(check.autoApplied).toBe(0)
    expect(await server.request<UpdateInfo[]>('/api/store/updates')).toContainEqual(expect.objectContaining({ appId, currentVersion: '1.0.0', latestVersion: '2.0.0' }))
    await page.locator('nav').getByRole('button', { name: 'Store', exact: true }).click()
    const back = page.getByRole('button', { name: 'Back to Store', exact: true })
    if (await back.isVisible()) await back.click()
    await page.getByTitle('Refresh', { exact: true }).click()
    await expect(page.getByTitle('Refresh', { exact: true })).toBeEnabled()
    await openLibrary(page)
    await card(page).click()
    const update = page.getByRole('button', { name: 'Update to v2.0.0', exact: true })
    await update.click()
    const upgrade = page.locator('.fixed.inset-0').filter({ has: page.getByRole('heading', { name: 'Update available', exact: true }) })
    await expect(upgrade).toContainText('The current skill package has changes that would be kept by a normal update.')
    const applyPath = `/api/store/updates/${appId}/apply`
    await upgrade.getByRole('button', { name: /^Keep current version/ }).click()
    await expect(upgrade).toHaveCount(0)
    expect(mutations.filter(item => item.path === applyPath)).toEqual([])
    expect(await readApp()).toMatchObject({ id: appId, status: 'paused', spec: { version: '1.0.0' } })
    assertPackage(server, await server.read(ref), customized)
    await expect(page.getByText('v1.0.0', { exact: true })).toBeVisible()
    await expect(update).toHaveCount(0)
    expect(await server.request<UpdateInfo[]>('/api/store/updates')).not.toContainEqual(expect.objectContaining({ appId, latestVersion: '2.0.0' }))
    snapshots.push({ stage: 'kept', app: await readApp(), detail: await server.read(ref) })
    expect(await controls(server)).toEqual(baseline)

    registry.publish(true)
    await server.request('/api/store/refresh', {})
    await server.request('/api/store/updates/check-now', {})
    await page.locator('nav').getByRole('button', { name: 'Store', exact: true }).click()
    if (await back.isVisible()) await back.click()
    await page.getByTitle('Refresh', { exact: true }).click()
    await expect(page.getByTitle('Refresh', { exact: true })).toBeEnabled()
    await openLibrary(page)
    await card(page).click()
    await page.getByRole('button', { name: 'Update to v3.0.0', exact: true }).click()
    await expect(upgrade.getByRole('button', { name: /^Replace with new version/ })).toBeEnabled()
    await expect(upgrade).toContainText('Local edits will be lost; nothing is automatically merged.')
    const applied = page.waitForResponse(response => new URL(response.url()).pathname === applyPath && response.request().method() === 'POST')
    await upgrade.getByRole('button', { name: /^Replace with new version/ }).click()
    const outcome = await (await applied).json()
    expect(outcome).toMatchObject({ success: true, data: { appId, from: '1.0.0', to: '3.0.0', kept: [] } })
    expect(mutations.filter(item => item.path === applyPath)).toEqual([{ path: applyPath, body: { mode: 'force' } }])
    await expect(upgrade).toHaveCount(0)
    await expect(page.getByRole('status').getByText('Updated to version 3.0.0.', { exact: true })).toBeVisible()
    await expect(page.getByText('v3.0.0', { exact: true })).toBeVisible()
    await expect(page.getByText(registry.third.body, { exact: true })).toBeVisible()
    const replaced = await server.read(ref)
    assertPackage(server, replaced, registry.third.files)
    expect(replaced.copy).toMatchObject({ id: copy.id, appId, enabled: false, availability: 'disabled' })
    expect(await readApp()).toMatchObject({ id: appId, status: 'paused', spec: { version: '3.0.0', skill_files: registry.third.files, store: installed[0].spec.store }, userOverrides: { skill: { customized: false } } })
    expect(existsSync(join(dirname(copy.path), 'references/obsolete.md'))).toBe(false)
    await page.getByRole('button', { name: 'Back to capability library', exact: true }).click()
    await page.getByRole('button', { name: 'Refresh skills', exact: true }).click()
    await expect(card(page).getByText('v3.0.0', { exact: true })).toBeVisible()
    snapshots.push({ stage: 'replaced', outcome, app: await readApp(), detail: replaced })

    page = await server.restart()
    await openLibrary(page)
    await expect(card(page).getByText('Disabled', { exact: true })).toBeVisible()
    await expect(card(page).getByText('v3.0.0', { exact: true })).toBeVisible()
    await expect(card(page).getByRole('button', { name: 'Update to v2.0.0', exact: true })).toHaveCount(0)
    await card(page).click()
    await expect(page.getByText(registry.third.body, { exact: true })).toBeVisible()
    await expect(page.getByText(customBody, { exact: true })).toHaveCount(0)
    assertPackage(server, await server.read(ref), registry.third.files)
    expect(await readApp()).toMatchObject({ id: appId, status: 'paused', spaceId: null, spec: { version: '3.0.0', store: installed[0].spec.store } })
    expect((await server.request<InstalledApp[]>('/api/apps?type=skill')).filter(app => app.spec.store?.slug === slug)).toHaveLength(1)
    expect((await server.list()).groups.find(group => group.name === slug)?.effectiveId).toBeUndefined()
    expect(await controls(server)).toEqual(baseline)
    expect(existsSync(join(server.profile, '.agents/skills', slug))).toBe(false)
    for (const resource of [registry.first, registry.third]) {
      for (const path of ['spec.yaml', ...Object.keys(resource.files).map(file => `files/${file}`)]) {
        expect(registry.requests).toContainEqual(expect.objectContaining({ path: `/${resource.entry.path}/${path}`, status: 200 }))
      }
    }
    snapshots.push({ stage: 'restarted', app: await readApp(), detail: await server.read(ref) })
  } finally {
    await info.attach('store-skill-wire-and-snapshots', { body: JSON.stringify({ requests: registry.requests, mutations, snapshots }, null, 2), contentType: 'application/json' })
  }
})
