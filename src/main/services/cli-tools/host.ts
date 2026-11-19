/**
 * The app's one CLI tool store, and how sessions and terminals get its tools.
 *
 * Bootstrap calls `initCliTools` with paths only; nothing touches the disk
 * until a session asks for its environment or the idle task prepares the
 * store. Every failure logs and degrades to "no tools": a broken tool store
 * must never stop a conversation or a terminal from starting.
 */

import { existsSync, promises as fsp } from 'fs'
import { delimiter, join } from 'path'
import { CliToolStore, type CliExecutionEntry, type CliToolState } from './store'
import { isCliToolError } from './errors'

/** Launcher directory of the tool set an environment was given; also tells the agent where TOOLS.md is. */
export const CLI_TOOLS_BIN_ENV = 'HALO_CLI_TOOLS_BIN'

export interface CliToolsHostOptions {
  /** Store root, e.g. `<userData>/cli`. */
  root: string
  /** Executable launched as Node. */
  runtimePath: string
  /** Directory of `.hcli` packages shipped with the build; null when the build has none. */
  presetDir: string | null
}

type Env = Record<string, string | number | undefined>

let options: CliToolsHostOptions | null = null
let store: CliToolStore | null = null
let prepared: Promise<void> | null = null
/** Owner of this process's pins; a later process releases them. */
const holder = `p${process.pid}-${Date.now().toString(36)}`

export function initCliTools(hostOptions: CliToolsHostOptions): void {
  options = hostOptions
}

function getStore(): CliToolStore | null {
  if (!options) return null
  store ??= new CliToolStore({
    root: options.root,
    runtimePath: options.runtimePath,
    runtimeNodeVersion: process.versions.node,
  })
  return store
}

/**
 * Clear locks left by an earlier app process, drop views nothing uses, and
 * import the packages shipped with this build. Runs once; the idle task
 * starts it and the first session waits for it.
 */
export function prepareCliTools(): Promise<void> {
  if (!prepared) prepared = runPrepare()
  return prepared
}

async function runPrepare(): Promise<void> {
  const cliStore = getStore()
  if (!cliStore || !options) return
  try {
    // A previous process's sessions are gone, so its pins protect nothing now.
    await cliStore.releaseOtherHolders(holder)
    await cliStore.pruneViews()
    if (options.presetDir) await importPresets(cliStore, options.presetDir, options.root)
  } catch (err) {
    console.error('[CliTools] Preparing the tool store failed; sessions continue without changes', {
      code: isCliToolError(err) ? err.code : 'UNEXPECTED',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

interface PresetStamp {
  files: Array<{ name: string; size: number; mtimeMs: number }>
}

/**
 * Import every `.hcli` in the build's preset directory. A preset becomes
 * current only when the tool has no current version or its current version
 * also came from a preset: a version the user or a catalog chose is kept.
 * An unchanged preset directory is skipped by its stamp, so later launches
 * re-hash nothing.
 */
async function importPresets(cliStore: CliToolStore, presetDir: string, root: string): Promise<void> {
  if (!existsSync(presetDir)) return
  const names = (await fsp.readdir(presetDir)).filter(name => name.endsWith('.hcli')).sort()
  const files: PresetStamp['files'] = []
  for (const name of names) {
    const stat = await fsp.stat(join(presetDir, name))
    files.push({ name, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) })
  }
  const stampFile = join(root, 'preset-stamp.json')
  const stamp = JSON.stringify({ files } satisfies PresetStamp)
  const previous = await fsp.readFile(stampFile, 'utf-8').catch(() => '')
  if (previous === stamp) return
  if (files.length === 0) return

  let failures = 0
  for (const name of names) {
    try {
      const state = await cliStore.readState()
      const result = await cliStore.importPackage(join(presetDir, name), {
        source: 'preset',
        activate: false,
      })
      const tool = (await cliStore.readState()).tools[result.id]
      if (shouldActivatePreset(state, result.id) && tool && tool.current !== result.version) {
        await cliStore.activateVersion(result.id, result.version)
      }
    } catch (err) {
      failures += 1
      console.error('[CliTools] Bundled tool not imported; the installed versions are unchanged', {
        file: name,
        code: isCliToolError(err) ? err.code : 'UNEXPECTED',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // A failed preset is retried on the next launch.
  if (failures === 0) {
    await fsp.mkdir(root, { recursive: true })
    await fsp.writeFile(stampFile, stamp, 'utf-8')
  }
  console.log('[CliTools] Bundled tools checked', { packages: names.length, failures })
}

/** Whether a bundled version may replace a tool's current version. */
export function shouldActivatePreset(stateBefore: CliToolState, toolId: string): boolean {
  const tool = stateBefore.tools[toolId]
  if (!tool?.current) return true
  return tool.versions[tool.current]?.source === 'preset'
}

/** PATH as a child would get it; Windows names are case-insensitive (see child-env). */
function readEnvPath(env: Env): string | undefined {
  const key = process.platform === 'win32'
    ? Object.keys(env).filter(name => name.toUpperCase() === 'PATH').sort()[0]
    : 'PATH'
  const value = key ? env[key] : undefined
  return typeof value === 'string' ? value : undefined
}

function writeEnvPath(env: Env, value: string): void {
  if (process.platform === 'win32') {
    for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH') delete env[name]
    env.Path = value
  } else {
    env.PATH = value
  }
}

/**
 * Give an environment the tool set current right now: append its launcher
 * directory to PATH and name it in `HALO_CLI_TOOLS_BIN`. Appending means a
 * launcher never shadows a command the user already has, and a name that is
 * taken is exposed as `halo-<name>`. Returns the directory, or null when no
 * tool is usable (the environment is then left without either change).
 *
 * The directory is content-addressed: a session built with it keeps those
 * exact versions, and an environment assembled after an update gets a new
 * directory.
 */
export async function applyCliToolsEnv(
  env: Env,
  request: { entry: CliExecutionEntry; engine: string }
): Promise<string | null> {
  delete env[CLI_TOOLS_BIN_ENV]
  const cliStore = getStore()
  if (!cliStore) return null
  try {
    await prepareCliTools()
    const basePath = readEnvPath(env)
    const pin = await cliStore.pinCurrent({ holder, entry: request.entry, engine: request.engine, basePath })
    if (!pin?.binDir) return null
    writeEnvPath(env, basePath ? `${basePath}${delimiter}${pin.binDir}` : pin.binDir)
    env[CLI_TOOLS_BIN_ENV] = pin.binDir
    return pin.binDir
  } catch (err) {
    console.error('[CliTools] Tools not added to this environment', {
      entry: request.entry,
      engine: request.engine,
      code: isCliToolError(err) ? err.code : 'UNEXPECTED',
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
