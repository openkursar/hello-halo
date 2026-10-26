import { test as base, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { RegistryEntry, RegistrySource, StoreQueryResponse } from '../../../src/shared/store/store-types'
import { cleanupTestConfigDir, createTestConfigDir, getAppEntryPath, launchElectronApp } from './electron'
import { closeManagementApp, trackManagementApp, type OwnedManagementApp } from './acceptance-management-process'
import { waitForHomePage } from './helpers'

export interface RegistryResource {
  entry: RegistryEntry
  spec: Record<string, unknown>
  files?: Record<string, string>
}

export interface RegistryDataset {
  id: string
  name: string
  resources: RegistryResource[]
  unavailable?: boolean
}

interface RegistryRequest {
  method: string
  path: string
  status: number
  validator?: string
}

interface LocalRegistry {
  url: string
  sources: RegistrySource[]
  requests: RegistryRequest[]
  publish(sourceId: string, resources: RegistryResource[]): void
  setUnavailable(sourceId: string, unavailable: boolean): void
  failNext(path: string, status?: number): void
}

interface RegistryApplication {
  profile: string
  app: ElectronApplication
  window: Page
  restart(): Promise<Page>
}

interface RegistryFixtures {
  // The object keeps source arrays distinct from Playwright's [value, options] fixture tuple.
  registryCatalog: { sources: RegistryDataset[] }
  registry: LocalRegistry
  registryApp: RegistryApplication
  window: Page
}

const builtinIds = ['official', 'mcp-official', 'smithery', 'claude-skills', 'skillhub'] as const

export function registryPerson(slug: string, name: string, options: {
  version?: string
  category?: string
  description?: string
  prompt?: string
  skills?: string[]
  config?: Array<Record<string, unknown>>
} = {}): RegistryResource {
  const version = options.version ?? '1.0.0'
  const description = options.description ?? `Local acceptance definition for ${name}.`
  const category = options.category ?? 'data'
  return {
    entry: { slug, name, version, author: 'Local acceptance', description, type: 'automation', format: 'bundle', path: `apps/${slug}/${version}`, category, tags: ['acceptance'], updated_at: '2026-01-01T00:00:00.000Z', requires_skills: options.skills },
    spec: {
      spec_version: '1.0', name, version, author: 'Local acceptance', description, type: 'automation',
      system_prompt: options.prompt ?? 'Review only the supplied local evidence and state what remains uncertain.',
      subscriptions: [], config_schema: options.config ?? [], requires: options.skills?.length ? { skills: options.skills } : {},
      permissions: [], store: { slug, category, tags: ['acceptance'] },
    },
  }
}

export function registrySkill(slug: string, name: string, version = '1.0.0'): RegistryResource {
  const files = {
    'SKILL.md': `---\nname: ${slug}\ndescription: Check local evidence before reporting.\nuser-invocable: true\n---\n\n# ${name}\n\nRead references/checklist.md before drawing a conclusion.\n`,
    'references/checklist.md': `Evidence checklist version ${version}: identify missing sources and uncertain conclusions.\n`,
  }
  return {
    entry: { slug, name: slug, display_name: name, version, author: 'Local acceptance', description: 'A complete local evidence skill.', type: 'skill', format: 'bundle', path: `apps/${slug}/${version}`, category: 'productivity', tags: ['acceptance'], updated_at: '2026-01-01T00:00:00.000Z' },
    spec: { spec_version: '1.0', name: slug, display_name: name, version, author: 'Local acceptance', description: 'A complete local evidence skill.', type: 'skill', skill_files: Object.keys(files), store: { slug, category: 'productivity', tags: ['acceptance'] } },
    files,
  }
}

export function registryMcp(slug: string, name: string): RegistryResource {
  return {
    entry: { slug, name, version: '1.0.0', author: 'Local acceptance', description: 'A local MCP catalog entry; installation is through Manual Add.', type: 'mcp', format: 'bundle', path: `apps/${slug}/1.0.0`, category: 'dev-tools', tags: ['acceptance'] },
    spec: { spec_version: '1.0', name, version: '1.0.0', author: 'Local acceptance', description: 'A local MCP catalog entry; installation is through Manual Add.', type: 'mcp', mcp_server: { transport: 'streamable-http', command: 'http://127.0.0.1:9/mcp' }, store: { slug, category: 'dev-tools', tags: ['acceptance'] } },
  }
}

export function registryAcceptance(caseId: string) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'app-e2e', mode: 'none', variant: {} }) } }
}

function containedFile(root: string, path: string): string {
  const target = resolve(root, path)
  const within = relative(root, target)
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Registry fixture path must be a file below its own root')
  return target
}

function writeSource(root: string, dataset: RegistryDataset) {
  const sourceRoot = containedFile(root, dataset.id)
  mkdirSync(sourceRoot, { recursive: true })
  const envelope = (resources: RegistryResource[]) => ({ version: 1, generated_at: '2026-01-01T00:00:00.000Z', source: dataset.id, apps: resources.map(resource => resource.entry) })
  writeFileSync(join(sourceRoot, 'index.json'), JSON.stringify(envelope(dataset.resources)))
  for (const [file, type] of [['digital-humans.json', 'automation'], ['skills.json', 'skill'], ['mcps.json', 'mcp']]) {
    writeFileSync(join(sourceRoot, file), JSON.stringify(envelope(dataset.resources.filter(resource => resource.entry.type === type))))
  }
  for (const resource of dataset.resources) {
    const folder = containedFile(sourceRoot, resource.entry.path)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'spec.yaml'), stringify(resource.spec))
    for (const [name, content] of Object.entries(resource.files ?? {})) {
      const file = containedFile(folder, `files/${name}`)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
  }
}

export const test = base.extend<RegistryFixtures>({
  registryCatalog: [{ sources: [{ id: 'acceptance-primary', name: 'Local evidence registry', resources: [] }] }, { option: true }],
  registry: async ({ registryCatalog }, use, testInfo) => {
    const root = testInfo.outputPath('registry-files')
    const registryDatasets = registryCatalog.sources
    const datasets = new Map(registryDatasets.map(dataset => [dataset.id, structuredClone(dataset)]))
    const revisions = new Map(registryDatasets.map(dataset => [dataset.id, 1]))
    const requests: RegistryRequest[] = []
    const failures = new Map<string, number>()
    for (const dataset of datasets.values()) writeSource(root, dataset)
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const sourceId = pathname.split('/')[1]
      const dataset = datasets.get(sourceId)
      const validator = typeof request.headers['if-none-match'] === 'string' ? request.headers['if-none-match'] : undefined
      const respond = (status: number, body: string | Buffer, headers: Record<string, string> = {}) => {
        requests.push({ method: request.method ?? '', path: pathname, status, ...(validator ? { validator } : {}) })
        response.writeHead(status, headers)
        response.end(body)
      }
      if (request.method !== 'GET') { respond(405, 'Only fixture reads are supported'); return }
      if (!dataset) { respond(404, 'Unknown fixture source'); return }
      if (dataset.unavailable) { respond(503, 'Controlled source unavailability'); return }
      const failed = failures.get(pathname)
      if (failed) { failures.delete(pathname); respond(failed, 'Controlled artifact transfer failure'); return }
      let file: string
      try { file = containedFile(root, decodeURIComponent(pathname.slice(1))) }
      catch { respond(400, 'Invalid fixture resource path'); return }
      if (!existsSync(file) || !statSync(file).isFile()) { respond(404, 'Fixture resource missing'); return }
      const index = ['index.json', 'digital-humans.json', 'skills.json', 'mcps.json'].some(name => pathname === `/${sourceId}/${name}`)
      const etag = `"${sourceId}-${revisions.get(sourceId)}"`
      if (index && validator === etag) { respond(304, '', { etag }); return }
      respond(200, readFileSync(file), { 'content-type': extname(file) === '.json' ? 'application/json' : 'text/plain; charset=utf-8', ...(index ? { etag } : {}) })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The local registry has no TCP address')
    const url = `http://127.0.0.1:${address.port}`
    try {
      await use({
        url,
        sources: [...datasets.values()].map(dataset => ({ id: dataset.id, name: dataset.name, url: `${url}/${dataset.id}`, enabled: true, sourceType: 'halo' })),
        requests,
        publish(sourceId, resources) {
          const dataset = datasets.get(sourceId)
          if (!dataset) throw new Error(`Unknown fixture source: ${sourceId}`)
          dataset.resources = structuredClone(resources)
          revisions.set(sourceId, revisions.get(sourceId)! + 1)
          writeSource(root, dataset)
        },
        setUnavailable(sourceId, unavailable) {
          const dataset = datasets.get(sourceId)
          if (!dataset) throw new Error(`Unknown fixture source: ${sourceId}`)
          dataset.unavailable = unavailable
        },
        failNext(path, status = 503) { failures.set(path, status) },
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await testInfo.attach('local-registry-requests', { body: JSON.stringify(requests, null, 2), contentType: 'application/json' })
    }
  },
  registryApp: async ({ registry }, use, testInfo) => {
    if (process.env.HALO_E2E_PACKAGED_APP) throw new Error('Local registry acceptance requires the unpackaged build so source policy can be inspected before startup')
    const entry = getAppEntryPath()
    const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const policyPath = join(project, existsSync(join(project, 'product.local.json')) ? 'product.local.json' : 'product.json')
    const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as { registryOverrides?: Record<string, { hidden?: boolean; enabled?: boolean }> }
    for (const id of builtinIds) {
      const override = policy.registryOverrides?.[id]
      if (override?.enabled === true && override.hidden !== true) throw new Error(`Local registry acceptance requires a build that permits disabling the ${id} source`)
    }
    const disabled: RegistrySource[] = builtinIds.map(id => ({ id, name: `Disabled ${id}`, url: `${registry.url}/disabled/${id}`, enabled: false, sourceType: 'halo' }))
    const profile = createTestConfigDir(entry, [...disabled, ...registry.sources])
    const configuration = join(profile, '.halo/config.json')
    const config = JSON.parse(readFileSync(configuration, 'utf8'))
    config.api = { provider: 'openai', apiKey: '', apiUrl: 'http://127.0.0.1:9', model: 'not-configured' }
    config.aiSources = { version: 2, currentId: null, sources: [] }
    config.agent = { ...config.agent, sdkEngine: 'halo', configDirMode: 'custom', customConfigDir: join(profile, 'sdk-state') }
    config.modelConfigSkipped = true
    config.imChannels = { instances: [] }
    config.notificationChannels = {}
    config.appStore.autoCheckUpdates = false
    writeFileSync(configuration, JSON.stringify(config, null, 2))
    const owned: OwnedManagementApp[] = []
    const close = async (app: ElectronApplication) => {
      const item = owned.find(item => item.application === app)
      if (!item) throw new Error('Refusing to close an application outside this registry fixture')
      await closeManagementApp(item)
    }
    const open = async () => {
      const app = await launchElectronApp(entry, profile, { bootstrapDirectory: project })
      owned.push(trackManagementApp(app))
      try {
        const window = await app.firstWindow()
        await window.waitForLoadState('domcontentloaded')
        await waitForHomePage(window)
        await expect.poll(() => window.evaluate(async () => {
          const api = (globalThis.window as unknown as { halo: HaloAPI }).halo
          const [apps, sources] = await Promise.all([api.appList(), api.storeGetRegistries()])
          return apps.success && sources.success
        }), { timeout: 30000 }).toBe(true)
        const sources = await window.evaluate(() => (globalThis.window as unknown as { halo: HaloAPI }).halo.storeGetRegistries())
        const enabled = (sources.data as RegistrySource[]).filter(source => source.enabled)
        expect(enabled.every(source => registry.sources.some(local => local.id === source.id && local.url === source.url)), 'Only the declared local registry sources may be enabled').toBe(true)
        const capabilities = await window.evaluate(() => (globalThis.window as unknown as { halo: HaloAPI }).halo.storeGetCapabilities())
        expect(capabilities).toMatchObject({ success: true, data: { catalog: true } })
        return { app, window }
      } catch (error) {
        await close(app)
        throw error
      }
    }
    let application: RegistryApplication | undefined
    try {
      application = {
        profile,
        ...await open(),
        async restart() {
          await close(this.app)
          const next = await open()
          this.app = next.app
          this.window = next.window
          return this.window
        },
      }
      await use(application)
    } finally {
      try {
        if (application && !application.window.isClosed()) await application.window.screenshot({ path: testInfo.outputPath('registry-final-window.png') })
      } finally {
        try { if (application) await close(application.app) }
        finally {
          const log = join(profile, '.halo/logs/main.log')
          if (existsSync(log)) await testInfo.attach('registry-main-log', { body: readFileSync(log).subarray(-1000000), contentType: 'text/plain' })
          if (owned.every(item => item.closed)) cleanupTestConfigDir(profile)
          else console.error('[AcceptanceRegistry] Retained the isolated profile because an owned application has not exited', { profile, pids: owned.filter(item => !item.closed).map(item => item.application.process().pid) })
        }
      }
    }
  },
  window: async ({ registryApp }, use) => { await use(registryApp.window) },
})

export async function queryRegistry(page: Page, options: { type?: string; search?: string; category?: string; pageSize?: number; page?: number } = {}): Promise<StoreQueryResponse> {
  const result = await page.evaluate(options => (window as unknown as { halo: HaloAPI }).halo.storeQuery({ page: 1, pageSize: 100, ...options }), options)
  expect(result.success).toBe(true)
  return result.data as StoreQueryResponse
}

export async function installedRegistryResources(page: Page): Promise<InstalledApp[]> {
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.appList())
  expect(result.success).toBe(true)
  return result.data as InstalledApp[]
}

export async function openRegistry(page: Page, type: 'Digital Human' | 'Skill' | 'MCP' = 'Digital Human') {
  await waitForHomePage(page)
  await page.getByRole('button', { name: 'Store', exact: true }).first().click()
  const back = page.getByRole('button', { name: 'Back to Store', exact: true })
  if (await back.isVisible()) await back.click()
  await page.getByRole('button', { name: type, exact: true }).click()
  await expect(page.getByPlaceholder('Search Digital Humans / Skills / MCP', { exact: true })).toBeVisible()
}

export function registryCard(page: Page, name: string): Locator {
  return page.getByText(name, { exact: true }).locator('xpath=ancestor::div[@role="button"][1]')
}

export async function openRegistryDetail(page: Page, name: string) {
  const card = registryCard(page, name)
  await expect(card).toHaveCount(1)
  await card.click()
  await expect(page.getByRole('button', { name: 'Back to Store', exact: true })).toBeVisible()
}

export async function openRegistryInstall(page: Page, name: string, type: 'automation' | 'skill' = 'automation'): Promise<Locator> {
  await openRegistryDetail(page, name)
  await page.getByRole('button', { name: type === 'skill' ? 'Add' : 'Install', exact: true }).click()
  const dialog = page.locator('.fixed.inset-0').filter({ has: page.getByRole('heading', { name, exact: true, level: 2 }) })
  await expect(dialog).toBeVisible()
  return dialog
}

export { expect } from '@playwright/test'
