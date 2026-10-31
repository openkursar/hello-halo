import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { McpSpec } from '../../../src/shared/apps/spec-types'
import type { CliConfigPaths } from '../../../src/renderer/types'
import { test as base, expect } from './acceptance-management'
import { startAcceptanceMcp } from './acceptance-mcp'
import { navigateToSettings } from './helpers'

export function ownedCliPath(profile: string, candidate: string): string {
  const root = realpathSync(profile)
  const destination = resolve(candidate)
  const suffix = relative(resolve(profile), destination)
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new Error('CLI migration path must be inside its owned profile')
  }
  let ancestor = destination
  while (!existsSync(ancestor)) {
    try {
      if (lstatSync(ancestor).isSymbolicLink()) throw new Error('CLI migration path contains a dangling link')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    ancestor = dirname(ancestor)
  }
  const resolvedSuffix = relative(root, realpathSync(ancestor))
  if (isAbsolute(resolvedSuffix) || resolvedSuffix === '..' || resolvedSuffix.startsWith(`..${sep}`)) {
    throw new Error('CLI migration path resolves outside its owned profile')
  }
  return destination
}

export function writeCliFile(profile: string, path: string, bytes: string | Buffer) {
  const destination = ownedCliPath(profile, path)
  mkdirSync(dirname(destination), { recursive: true })
  ownedCliPath(profile, destination)
  writeFileSync(destination, bytes)
}

export function cliTree(profile: string, root: string): Record<string, string> {
  ownedCliPath(profile, root)
  if (!existsSync(root)) return {}
  const files: Record<string, string> = {}
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = ownedCliPath(profile, join(directory, entry))
      const info = lstatSync(path)
      if (info.isSymbolicLink()) throw new Error('Synthetic CLI resources must not contain symbolic links')
      if (info.isDirectory()) visit(path)
      else if (info.isFile()) files[relative(root, path).split(sep).join('/')] = readFileSync(path).toString('base64')
      else throw new Error('Synthetic CLI resource has an unsupported file type')
    }
  }
  visit(root)
  return files
}

export async function cliPaths(page: Page): Promise<CliConfigPaths> {
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.cliConfigGetPaths())
  expect(result.success, 'The real application must resolve its CLI configuration directories').toBe(true)
  expect(result.data).toBeTruthy()
  return result.data as CliConfigPaths
}

async function assertCliIsolation(app: ElectronApplication, page: Page, profile: string) {
  const actual = await app.evaluate(({ app }) => {
    const os = process.getBuiltinModule('node:os') as typeof import('node:os')
    return { home: process.env.HOME, userProfile: process.env.USERPROFILE, resolvedHome: os.homedir(), userData: app.getPath('userData') }
  })
  for (const home of [actual.home, actual.userProfile, actual.resolvedHome]) {
    expect(typeof home).toBe('string')
    expect(realpathSync(home!)).toBe(realpathSync(profile))
  }
  ownedCliPath(profile, actual.userData)
  const paths = await cliPaths(page)
  expect(paths.ccDefault).toBe(join(actual.resolvedHome, '.claude'))
  expect(paths.haloDefault).toBe(join(actual.userData, 'claude-config'))
  for (const path of [paths.ccDefault, paths.haloDefault, paths.current, ...(paths.customConfigDir ? [paths.customConfigDir] : [])]) ownedCliPath(profile, path)
  return { actual, paths }
}

export const test = base.extend<{
  migrationMcp: Awaited<ReturnType<typeof startAcceptanceMcp>>
  cliMigration: {
    profile: string
    window: Page
    paths: CliConfigPaths
    mcpUrl: string
    restart(): Promise<Page>
  }
}>({
  migrationMcp: async ({}, use, testInfo) => {
    const service = await startAcceptanceMcp()
    try { await use(service) }
    finally {
      await testInfo.attach('cli-migration-mcp-receipts', { body: JSON.stringify({ requests: service.requests, calls: service.calls }), contentType: 'application/json' })
      await service.close()
    }
  },
  cliMigration: async ({ migrationMcp, managementApp }, use, testInfo) => {
    const launches = [await assertCliIsolation(managementApp.app, managementApp.window, managementApp.profile)]
    const session = {
      profile: managementApp.profile,
      window: managementApp.window,
      paths: launches[0].paths,
      mcpUrl: migrationMcp.url,
      async restart() {
        this.window = await managementApp.restart()
        const observed = await assertCliIsolation(managementApp.app, this.window, managementApp.profile)
        launches.push(observed)
        this.paths = observed.paths
        return this.window
      },
    }
    try { await use(session) }
    finally { await testInfo.attach('cli-migration-isolation', { body: JSON.stringify({ launches }, null, 2), contentType: 'application/json' }) }
  },
})

export function cliAcceptance(caseId: string, variant: Record<string, string> = {}) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, variant, evidence: 'app-e2e', mode: 'none' }) } }
}

export async function cliPanel(page: Page, title: string): Promise<Locator> {
  if (!(await page.locator('#advanced').isVisible())) await navigateToSettings(page)
  const trigger = page.locator('#advanced').getByRole('button').filter({ has: page.getByText(title, { exact: true }) })
  await expect(trigger).toHaveCount(1)
  await trigger.scrollIntoViewIfNeeded()
  const panel = trigger.locator('..')
  if (await panel.locator(':scope > div.border-t').count() === 0) await trigger.click()
  await expect(panel.locator(':scope > div.border-t')).toBeVisible()
  return panel
}

export function migrationRow(_page: Page, panel: Locator, name: string): Locator {
  return panel.getByText(name, { exact: true }).locator('../..')
}

export async function migrationApps(page: Page): Promise<InstalledApp[]> {
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.appList({ type: 'mcp' }))
  expect(result.success).toBe(true)
  return result.data as InstalledApp[]
}

export async function installMigrationControl(page: Page, name: string, url: string): Promise<InstalledApp> {
  const spec: McpSpec = {
    spec_version: '1', type: 'mcp', name, version: '1.0', author: 'Acceptance fixture',
    description: 'An existing isolated connection.',
    mcp_server: { transport: 'streamable-http', command: url, headers: { 'X-Acceptance-Revision': 'existing' } },
  }
  const result = await page.evaluate(spec => (window as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId: null, spec, userConfig: { ACCEPTANCE_SETTING: 'existing' },
  }), spec)
  expect(result.success, 'Existing MCP controls must use the real install API').toBe(true)
  const id = (result.data as { appId: string }).appId
  const app = (await migrationApps(page)).find(app => app.id === id)
  expect(app).toMatchObject({ specId: name, spaceId: null, status: 'active' })
  return app!
}

export { expect } from '@playwright/test'
