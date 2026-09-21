/**
 * Codex E2E Fixture
 *
 * Variant of `electron.ts` that:
 *   1. Forces `config.agent.sdkEngine = "codex"`.
 *   2. Reuses the user's real `~/.halo/config.json` aiSources so an existing
 *      Codex-capable provider (gpt-*) can authenticate without a fresh API key.
 *   3. Snapshots/forces a sensible `currentId` pointing at a gpt-* source.
 *   4. Surfaces a clear skip when no Codex-capable source is available.
 *
 * The user's real config is NEVER mutated — we only READ it and write a copy
 * into a temporary test HOME / HALO_DATA_DIR.
 */

import { test as base, ElectronApplication, Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface CodexElectronFixtures {
  electronApp: ElectronApplication
  window: Page
  codexSourceId: string
  electronLog: { lines: string[]; logFilePath: string }
}

interface CodexCapableSource {
  id: string
  provider: string
  model: string
}

/**
 * Locate the built app entry, from package.json's `main`: we want to run
 * against the working tree's dev build, not a packaged release, and the
 * bundle's module format is a build setting there.
 */
function getAppEntryPath(): string {
  const projectRoot = path.resolve(__dirname, '../../..')
  const main = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')).main as string
  const appEntryPath = path.resolve(projectRoot, main)
  if (!fs.existsSync(appEntryPath)) {
    throw new Error(
      `Built app not found at ${appEntryPath}. Run "npm run build" first.`
    )
  }
  ensureProductJson(projectRoot)
  return appEntryPath
}

/**
 * See electron.ts for full rationale: app.getAppPath() returns out/main/ in
 * E2E, so product.json must live there with paths rewritten relative to it.
 */
function ensureProductJson(projectRoot: string): void {
  const srcProductJson = path.join(projectRoot, 'product.json')
  const destDir = path.join(projectRoot, 'out/main')
  const destProductJson = path.join(destDir, 'product.json')
  if (!fs.existsSync(srcProductJson)) return
  try {
    const product = JSON.parse(fs.readFileSync(srcProductJson, 'utf-8'))
    if (product.authProviders) {
      for (const provider of product.authProviders) {
        if (provider.path && provider.path.startsWith('./')) {
          const absolutePath = path.resolve(projectRoot, provider.path)
          provider.path = path.relative(destDir, absolutePath)
        }
      }
    }
    fs.writeFileSync(destProductJson, JSON.stringify(product, null, 2))
  } catch (err) {
    console.warn('[codex-e2e] Failed to copy product.json:', err)
  }
}

/**
 * Try `~/.halo` then `~/.halo-dev` for the user's existing config.
 */
function loadUserHaloConfig(): { dir: string; config: Record<string, any> } | null {
  const home = os.homedir()
  for (const dir of [path.join(home, '.halo'), path.join(home, '.halo-dev')]) {
    const file = path.join(dir, 'config.json')
    if (fs.existsSync(file)) {
      try {
        const config = JSON.parse(fs.readFileSync(file, 'utf-8'))
        return { dir, config }
      } catch {
        continue
      }
    }
  }
  return null
}

/**
 * A source is Codex-capable if it speaks an OpenAI-compatible wire (anything
 * non-anthropic). Codex routes any non-Anthropic model through the Halo
 * OpenAI-compat router (see resolveCodexModel in
 * src/main/services/agent/codex/options.ts), so the gating constraint is
 * "must NOT be anthropic-only", not "must be gpt-*". This broadening lets the
 * test pick stable providers (siliconflow GLM, mimo, openrouter, etc.) when
 * the user's primary gpt-* source is out of credits or unstable.
 */
function pickCodexCapableSource(config: Record<string, any>): CodexCapableSource | null {
  const sources = config?.aiSources?.sources
  if (!Array.isArray(sources) || sources.length === 0) return null

  const isAnthropicOnly = (s: any): boolean => {
    const provider = String(s?.provider || '').toLowerCase()
    const model = String(s?.model || '').toLowerCase()
    if (provider === 'anthropic' || provider === 'claude') return true
    // Codex strips claude-* in resolveCodexModel and falls back to a gpt model
    // the source likely doesn't host, so claude-* sources can't drive codex.
    if (model.startsWith('claude-')) return true
    return false
  }

  const isViableForCodex = (s: any): boolean => {
    if (!s || typeof s !== 'object') return false
    if (typeof s.model !== 'string' || !s.model) return false
    if (typeof s.apiKey !== 'string' || !s.apiKey.trim()) return false
    if (typeof s.apiUrl !== 'string' || !s.apiUrl.trim()) return false
    if (isAnthropicOnly(s)) return false
    return true
  }

  // 1) Explicit env override always wins (so users can pin a known-good source).
  const envId = process.env.HALO_CODEX_TEST_SOURCE_ID
  if (envId) {
    const match = sources.find((s: any) => s?.id === envId)
    if (match && isViableForCodex(match)) {
      return { id: match.id, provider: match.provider, model: match.model }
    }
  }

  // 2) Currently selected source if viable.
  const currentId = config?.aiSources?.currentId
  const current = sources.find((s: any) => s?.id === currentId)
  if (current && isViableForCodex(current)) {
    return { id: current.id, provider: current.provider, model: current.model }
  }

  // 3) Stability-first preference order — siliconflow / openrouter known
  //    stable; gpt-* third (skip codex-low, too weak for tool calling); any
  //    other viable source last.
  const preferred: Array<(s: any) => boolean> = [
    (s) => String(s.provider).toLowerCase() === 'siliconflow',
    (s) => String(s.provider).toLowerCase() === 'openrouter',
    (s) => typeof s.model === 'string' && s.model.startsWith('gpt-') && !s.model.includes('codex-low'),
    (_s) => true,
  ]
  for (const pred of preferred) {
    const candidate = sources.find((s: any) => isViableForCodex(s) && pred(s))
    if (candidate) {
      return { id: candidate.id, provider: candidate.provider, model: candidate.model }
    }
  }
  return null
}

/**
 * Build a fresh test config dir that:
 *   - Mirrors the user's aiSources (so existing API keys work)
 *   - Forces sdkEngine = codex and currentId = the chosen gpt-* source
 *   - Skips onboarding / first-launch
 */
function createTestConfigDir(
  appPath: string,
  baseConfig: Record<string, any>,
  source: CodexCapableSource
): string {
  const testDir = path.join(
    process.env.TMPDIR || '/tmp',
    `halo-codex-e2e-${Date.now()}`
  )
  const haloDir = path.join(testDir, '.halo')
  fs.mkdirSync(path.join(haloDir, 'temp', 'artifacts'), { recursive: true })
  fs.mkdirSync(path.join(haloDir, 'temp', 'conversations'), { recursive: true })
  fs.mkdirSync(path.join(haloDir, 'spaces'), { recursive: true })

  // Clone the user's config; keep all aiSources entries (so any provider
  // referenced by mcpServers / runtime is still resolvable). Force currentId,
  // sdkEngine, and skip onboarding.
  const config: Record<string, any> = JSON.parse(JSON.stringify(baseConfig))

  config.aiSources = {
    version: 2,
    currentId: source.id,
    sources: baseConfig.aiSources?.sources ?? [],
  }

  // Mirror legacy `api` field to the chosen source so any code path still
  // reading the legacy field gets the correct credentials.
  const chosenSource = config.aiSources.sources.find((s: any) => s.id === source.id)
  if (chosenSource) {
    config.api = {
      provider: chosenSource.provider,
      apiKey: chosenSource.apiKey,
      apiUrl: chosenSource.apiUrl,
      model: chosenSource.model,
    }
  }

  config.agent = { ...(config.agent || {}), sdkEngine: 'codex', maxTurns: 999 }
  config.permissions = {
    fileAccess: 'allow',
    commandExecution: 'allow',
    networkAccess: 'allow',
    trustMode: true,
  }
  config.appearance = config.appearance || { theme: 'dark' }
  config.system = config.system || { autoLaunch: false }
  config.remoteAccess = { ...(config.remoteAccess || {}), enabled: false }
  config.onboarding = { completed: true }
  config.isFirstLaunch = false
  config.mcpServers = config.mcpServers || {}

  fs.writeFileSync(path.join(haloDir, 'config.json'), JSON.stringify(config, null, 2))

  // SDK headless-electron symlink for macOS (mirrors electron.ts).
  if (process.platform === 'darwin') {
    const userDataDir = path.join(testDir, 'Library', 'Application Support', 'Halo')
    const headlessDir = path.join(userDataDir, 'headless-electron')
    fs.mkdirSync(headlessDir, { recursive: true })
    try {
      fs.symlinkSync(appPath, path.join(headlessDir, 'electron-node'))
    } catch (err) {
      console.warn('[codex-e2e] Failed to create SDK symlink:', err)
    }
  }

  return testDir
}

function cleanupTestConfigDir(testDir: string): void {
  try {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  } catch (err) {
    console.warn('[codex-e2e] Failed to cleanup test dir:', err)
  }
}

// Pre-flight gate so describe-level skips can surface actionable messages.
const userConfig = loadUserHaloConfig()
const codexSource = userConfig ? pickCodexCapableSource(userConfig.config) : null

export const codexAvailability = {
  ok: !!(userConfig && codexSource),
  reason: !userConfig
    ? 'No ~/.halo or ~/.halo-dev config.json found. Configure Halo at least once before running this test.'
    : !codexSource
      ? 'No Codex-capable source found in aiSources. Add any non-Anthropic OpenAI-compatible provider (siliconflow, openrouter, openai, etc.) in Halo Settings → AI Sources, or set HALO_CODEX_TEST_SOURCE_ID to a specific source id.'
      : '',
  source: codexSource,
}

export const test = base.extend<CodexElectronFixtures>({
  codexSourceId: async ({}, use) => {
    if (!codexAvailability.ok || !codexSource) {
      throw new Error(codexAvailability.reason)
    }
    await use(codexSource.id)
  },

  electronApp: async ({}, use) => {
    if (!codexAvailability.ok || !userConfig || !codexSource) {
      throw new Error(codexAvailability.reason)
    }

    const appEntryPath = getAppEntryPath()
    const testConfigDir = createTestConfigDir(appEntryPath, userConfig.config, codexSource)

    console.log(`[codex-e2e] App entry: ${appEntryPath}`)
    console.log(`[codex-e2e] Test config dir: ${testConfigDir}`)
    console.log(
      `[codex-e2e] Using source: provider=${codexSource.provider} model=${codexSource.model} id=${codexSource.id.slice(0, 8)}`
    )

    const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = process.env

    const app = await electron.launch({
      args: [appEntryPath],
      env: {
        ...cleanEnv,
        HOME: testConfigDir,
        USERPROFILE: testConfigDir,
        HALO_DATA_DIR: path.join(testConfigDir, '.halo'),
        ELECTRON_DISABLE_GPU: '1',
        HALO_E2E_TEST: '1',
      },
    })

    // Attach stdout/stderr capture from the Electron main process. We tag
    // each line so the spec can post-filter, and we mirror everything to a
    // file the team-lead asked for: tests/e2e/codex-mcp-electron.log.
    const projectRoot = path.resolve(__dirname, '../../..')
    const logFilePath = path.join(projectRoot, 'tests/e2e/codex-mcp-electron.log')
    try {
      fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
      fs.writeFileSync(
        logFilePath,
        `# codex-mcp electron log — run started ${new Date().toISOString()}\n`,
      )
    } catch {
      /* swallow */
    }

    const lines: string[] = []
    const fileStream = fs.createWriteStream(logFilePath, { flags: 'a' })
    const child = app.process()
    const ingest = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      for (const raw of text.split(/\r?\n/)) {
        if (!raw) continue
        const tagged = `[${stream}] ${raw}`
        lines.push(tagged)
        fileStream.write(tagged + '\n')
      }
    }
    if (child?.stdout) child.stdout.on('data', (c) => ingest('stdout', c))
    if (child?.stderr) child.stderr.on('data', (c) => ingest('stderr', c))

    ;(app as any).__electronLog = { lines, logFilePath }

    await use(app)

    await app.close()
    try {
      fileStream.end()
    } catch {
      /* ignore */
    }
    cleanupTestConfigDir(testConfigDir)
  },

  electronLog: async ({ electronApp }, use) => {
    const log = (electronApp as any).__electronLog as
      | { lines: string[]; logFilePath: string }
      | undefined
    if (!log) {
      throw new Error('[codex-e2e] electronLog fixture used before electronApp attached log capture')
    }
    await use(log)
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await use(window)
  },
})

export { expect } from '@playwright/test'
