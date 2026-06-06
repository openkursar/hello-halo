/**
 * CLI Config IPC Handlers
 *
 * Handles Claude CLI config directory management and migration:
 * - Get current path configuration
 * - Scan and migrate Skills from ~/.claude/skills/ to Halo
 * - Scan and migrate MCP servers from ~/.claude.json to Halo
 * - Update CLAUDE_CONFIG_DIR mode (halo default / cc default / custom)
 *
 * Request/response channels are registered from the typed RPC contract
 * (passthrough — handler bodies and return shapes preserved verbatim).
 */

import { join, resolve } from 'path'
import { homedir } from 'os'
import { stat, readdir, mkdir, cp, readFile, access } from 'fs/promises'
import { getConfig, saveConfig, resolveClaudeConfigDir } from '../foundation/config.service'
import type { McpServerConfig } from '../foundation/config.service'
import { getAppManager, AppAlreadyInstalledError } from '../apps/manager'
import type { McpSpec } from '../apps/spec/schema'
import { cliConfigRpc } from '../../shared/rpc/contracts/cli-config.contract'
import { registerRawRpcHandlers } from './rpc'

// ============================================
// Path helpers
// ============================================

function getCCDefaultDir(): string {
  return join(homedir(), '.claude')
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// ============================================
// Register handlers
// ============================================

export function registerCliConfigHandlers(): void {
  registerRawRpcHandlers(cliConfigRpc, {
    // ── Get current path info ────────────────────────────────────────────────
    cliConfigGetPaths: async () => {
      console.log('[CliConfig] cli-config:get-paths')
      try {
        const config = getConfig()
        const mode = config.agent?.configDirMode ?? 'halo'
        return {
          success: true,
          data: {
            haloDefault: resolveClaudeConfigDir('halo'),
            ccDefault: getCCDefaultDir(),
            current: resolveClaudeConfigDir(mode, config.agent?.customConfigDir),
            configDirMode: mode,
            customConfigDir: config.agent?.customConfigDir,
          }
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[CliConfig] cli-config:get-paths failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── Scan skills for conflicts ────────────────────────────────────────────
    cliConfigScanSkills: async () => {
      console.log('[CliConfig] cli-config:scan-skills')
      try {
        const ccSkillsDir = join(getCCDefaultDir(), 'skills')
        const haloSkillsDir = join(resolveClaudeConfigDir('halo'), 'skills')

        if (!(await pathExists(ccSkillsDir))) {
          return { success: true, data: { skills: [], ccSkillsDir, haloSkillsDir } }
        }

        const entries = await readdir(ccSkillsDir)
        const skills: Array<{ name: string; ccPath: string; haloPath: string; exists: boolean }> = []

        for (const name of entries) {
          const entryPath = join(ccSkillsDir, name)
          const entryStat = await stat(entryPath)
          if (entryStat.isDirectory()) {
            skills.push({
              name,
              ccPath: entryPath,
              haloPath: join(haloSkillsDir, name),
              exists: await pathExists(join(haloSkillsDir, name)),
            })
          }
        }

        console.log(`[CliConfig] scan-skills: found ${skills.length} CC skills`)
        return { success: true, data: { skills, ccSkillsDir, haloSkillsDir } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[CliConfig] scan-skills failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── Migrate skills ───────────────────────────────────────────────────────
    cliConfigMigrateSkills: async (
      actions: Array<{ name: string; action: 'skip' | 'overwrite' | 'rename' }>
    ) => {
      console.log('[CliConfig] cli-config:migrate-skills, items:', actions.length)
      try {
        const ccSkillsDir = join(getCCDefaultDir(), 'skills')
        const haloSkillsDir = join(resolveClaudeConfigDir('halo'), 'skills')

        await mkdir(haloSkillsDir, { recursive: true })

        const results: Array<{ name: string; status: 'migrated' | 'skipped' | 'renamed' | 'error'; dest?: string; error?: string }> = []

        for (const { name, action } of actions) {
          const srcDir = join(ccSkillsDir, name)
          if (!(await pathExists(srcDir))) {
            results.push({ name, status: 'skipped' })
            continue
          }

          try {
            if (action === 'skip') {
              results.push({ name, status: 'skipped' })
              continue
            }

            let destName = name
            if (action === 'rename') {
              let suffix = 1
              while (await pathExists(join(haloSkillsDir, `${name}-cc${suffix > 1 ? String(suffix) : ''}`))) {
                suffix++
              }
              destName = `${name}-cc${suffix > 1 ? String(suffix) : ''}`
            }

            const destDir = join(haloSkillsDir, destName)
            await cp(srcDir, destDir, { recursive: true, force: true })
            console.log(`[CliConfig] Migrated skill: ${name} -> ${destName}`)
            results.push({ name, status: action === 'rename' ? 'renamed' : 'migrated', dest: destName })
          } catch (err: unknown) {
            const e = err as Error
            console.error(`[CliConfig] Failed to migrate skill '${name}':`, e.message)
            results.push({ name, status: 'error', error: e.message })
          }
        }

        const migratedCount = results.filter(r => r.status === 'migrated' || r.status === 'renamed').length
        console.log(`[CliConfig] Skills migration complete: ${migratedCount}/${actions.length} migrated`)
        return { success: true, data: { results } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[CliConfig] migrate-skills failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── Scan MCP servers for conflicts ──────────────────────────────────────
    cliConfigScanMcp: async () => {
      console.log('[CliConfig] cli-config:scan-mcp')
      try {
        const ccJsonPath = join(homedir(), '.claude.json')

        if (!(await pathExists(ccJsonPath))) {
          return { success: true, data: { servers: [], ccJsonPath } }
        }

        let ccData: Record<string, unknown>
        try {
          ccData = JSON.parse(await readFile(ccJsonPath, 'utf-8'))
        } catch {
          return { success: false, error: 'Failed to parse ~/.claude.json' }
        }

        // Check against App Manager DB (the active data source) instead of config.json
        const manager = getAppManager()
        const installedMcpNames = new Set<string>()
        if (manager) {
          const globalMcps = manager.listApps({ type: 'mcp', spaceId: null })
          for (const app of globalMcps) {
            if (app.status !== 'uninstalled') {
              installedMcpNames.add(app.specId)
            }
          }
        }

        const ccServers = (ccData.mcpServers ?? {}) as Record<string, unknown>
        const servers = Object.entries(ccServers).map(([name, ccConfig]) => ({
          name,
          ccConfig,
          haloConfig: installedMcpNames.has(name) ? ccConfig : undefined,
          exists: installedMcpNames.has(name),
        }))

        console.log(`[CliConfig] scan-mcp: found ${servers.length} CC MCP servers`)
        return { success: true, data: { servers, ccJsonPath } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[CliConfig] scan-mcp failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── Migrate MCP servers ──────────────────────────────────────────────────
    cliConfigMigrateMcp: async (
      actions: Array<{ name: string; action: 'skip' | 'overwrite' }>
    ) => {
      console.log('[CliConfig] cli-config:migrate-mcp, items:', actions.length)
      try {
        const ccJsonPath = join(homedir(), '.claude.json')
        if (!(await pathExists(ccJsonPath))) {
          return { success: false, error: '~/.claude.json not found' }
        }

        let ccData: Record<string, unknown>
        try {
          ccData = JSON.parse(await readFile(ccJsonPath, 'utf-8'))
        } catch {
          return { success: false, error: 'Failed to parse ~/.claude.json' }
        }

        const manager = getAppManager()
        if (!manager) {
          return { success: false, error: 'App Manager not initialized' }
        }

        const ccServers = (ccData.mcpServers ?? {}) as Record<string, McpServerConfig>
        const results: Array<{ name: string; status: 'merged' | 'skipped' | 'error'; error?: string }> = []

        for (const { name, action } of actions) {
          if (action === 'skip' || !(name in ccServers)) {
            results.push({ name, status: 'skipped' })
            continue
          }

          try {
            const spec = ccMcpConfigToSpec(name, ccServers[name])
            await manager.install(null, spec, buildUserConfigFromEnv(ccServers[name]))
            console.log(`[CliConfig] Migrated MCP server to DB: ${name}`)
            results.push({ name, status: 'merged' })
          } catch (err: unknown) {
            // Already installed is not an error — treat as success
            if (err instanceof AppAlreadyInstalledError) {
              console.log(`[CliConfig] MCP server '${name}' already installed, skipping`)
              results.push({ name, status: 'skipped' })
            } else {
              const e = err as Error
              console.error(`[CliConfig] Failed to migrate MCP server '${name}':`, e.message)
              results.push({ name, status: 'error', error: e.message })
            }
          }
        }

        const mergedCount = results.filter(r => r.status === 'merged').length
        console.log(`[CliConfig] MCP migration complete: ${mergedCount}/${actions.length} merged`)
        return { success: true, data: { results } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[CliConfig] migrate-mcp failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── Update config dir mode ───────────────────────────────────────────────
    cliConfigSetConfigDir: async (
      mode: 'halo' | 'cc' | 'custom',
      customDir?: string
    ) => {
      console.log('[CliConfig] cli-config:set-config-dir', mode, customDir)
      try {
        // Validate: custom mode requires a non-empty path
        if (mode === 'custom' && !customDir?.trim()) {
          return { success: false, error: 'A directory path is required when using Custom mode' }
        }

        const resolvedCustomDir = customDir ? resolve(customDir) : undefined

        // Validate custom dir exists
        if (mode === 'custom' && resolvedCustomDir && !(await pathExists(resolvedCustomDir))) {
          return { success: false, error: `Directory does not exist: ${resolvedCustomDir}` }
        }

        const currentConfig = getConfig()
        saveConfig({
          agent: {
            ...currentConfig.agent,
            configDirMode: mode,
            customConfigDir: mode === 'custom' ? resolvedCustomDir : undefined,
          }
        })

        const effectivePath = resolveClaudeConfigDir(mode, resolvedCustomDir)

        console.log(`[CliConfig] Config dir mode set to '${mode}': ${effectivePath}`)
        return {
          success: true,
          data: {
            mode,
            effectivePath,
            customConfigDir: resolvedCustomDir,
          }
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[CliConfig] set-config-dir failed:', err.message)
        return { success: false, error: err.message }
      }
    },
  })

  console.log('[CliConfig] CLI config handlers registered')
}

// ============================================
// CC config → McpSpec conversion helpers
// ============================================

/**
 * Convert a Claude Code MCP server config (from ~/.claude.json) into a valid
 * Halo McpSpec for installation into the App Manager DB.
 */
function ccMcpConfigToSpec(name: string, config: McpServerConfig): McpSpec {
  const typed = config as Record<string, unknown>
  const transport = inferTransport(typed)

  const spec: McpSpec = {
    spec_version: '1',
    name,
    type: 'mcp',
    version: '1.0',
    author: 'Claude Code',
    description: `Migrated from Claude Code: ${name}`,
    mcp_server: {
      transport,
      command: transport === 'stdio'
        ? (typed.command as string) || name
        : (typed.url as string) || name,
    },
  }

  // stdio-specific fields
  if (transport === 'stdio') {
    if (Array.isArray(typed.args) && typed.args.length > 0) {
      spec.mcp_server.args = typed.args as string[]
    }
    if (typeof typed.cwd === 'string') {
      spec.mcp_server.cwd = typed.cwd
    }
  }

  // headers (sse / http)
  if (typed.headers && typeof typed.headers === 'object' && Object.keys(typed.headers as object).length > 0) {
    spec.mcp_server.headers = typed.headers as Record<string, string>
  }

  // env goes into the spec as default env (user-provided values go into userConfig)
  // We intentionally keep env empty in spec and put everything in userConfig
  // so that user can edit them via the UI config form.

  return spec
}

/**
 * Infer the MCP transport type from CC config shape.
 */
function inferTransport(config: Record<string, unknown>): 'stdio' | 'sse' | 'streamable-http' {
  const type = config.type as string | undefined
  if (type === 'sse') return 'sse'
  if (type === 'http') return 'streamable-http'
  if (typeof config.url === 'string' && !config.command) {
    // Has URL but no command — network transport (sse already handled above)
    return 'streamable-http'
  }
  return 'stdio'
}

/**
 * Extract env vars from CC config as userConfig values.
 * CC stores env vars directly in the MCP config; Halo stores them as userConfig
 * which get merged into env at runtime (via getDbMcpServers in helpers.ts).
 */
function buildUserConfigFromEnv(config: McpServerConfig): Record<string, unknown> {
  const typed = config as Record<string, unknown>
  const env = typed.env as Record<string, string> | undefined
  if (!env || typeof env !== 'object') return {}
  // Copy all env vars as userConfig entries
  const userConfig: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(env)) {
    userConfig[key] = value
  }
  return userConfig
}

// ============================================
// One-time migration: config.json mcpServers → DB
// ============================================

/**
 * Migrate any MCP servers stored in the legacy config.json.mcpServers
 * into the App Manager DB. This handles MCPs that were previously migrated
 * from CC but written to the dead config.json path (Issue #74).
 *
 * Safe to call multiple times — skips already-installed MCPs.
 * Should be called after initAppManager() during startup.
 */
export async function migrateConfigMcpToDb(): Promise<void> {
  const config = getConfig()
  const legacyMcpServers = config.mcpServers
  if (!legacyMcpServers || Object.keys(legacyMcpServers).length === 0) {
    return
  }

  const manager = getAppManager()
  if (!manager) {
    console.warn('[CliConfig] Cannot migrate config.mcpServers: App Manager not initialized')
    return
  }

  console.log(`[CliConfig] Migrating ${Object.keys(legacyMcpServers).length} legacy config.mcpServers to DB...`)

  let migrated = 0
  let skipped = 0
  let failed = 0
  // Track entries that failed so we can preserve them for retry on next startup.
  const failedEntries: Record<string, McpServerConfig> = {}

  for (const [name, mcpConfig] of Object.entries(legacyMcpServers)) {
    try {
      const spec = ccMcpConfigToSpec(name, mcpConfig)
      await manager.install(null, spec, buildUserConfigFromEnv(mcpConfig))
      console.log(`[CliConfig] Migrated legacy MCP '${name}' to DB`)
      migrated++
    } catch (err: unknown) {
      if (err instanceof AppAlreadyInstalledError) {
        // Already in DB — expected if user already installed via App Store
        skipped++
      } else {
        const e = err as Error
        console.error(`[CliConfig] Failed to migrate legacy MCP '${name}':`, e.message)
        failed++
        failedEntries[name] = mcpConfig
      }
    }
  }

  // Write back only entries that failed — they will be retried on next startup.
  // Successfully migrated and skipped entries are cleared from config.json;
  // the DB is now their source of truth.
  saveConfig({ mcpServers: failedEntries })
  if (failed > 0) {
    console.warn(`[CliConfig] ${failed} MCP(s) failed to migrate — preserved in config.json for retry on next startup`)
  }
  console.log(`[CliConfig] Legacy config.mcpServers migration complete: ${migrated} migrated, ${skipped} skipped, ${failed} failed`)
}
