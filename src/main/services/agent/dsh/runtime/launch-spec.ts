/**
 * Assemble the `DshRuntimeLaunchSpec` the transport spawns.
 *
 * The child environment is built from an explicit allowlist rather than
 * inherited: dsh's credential plugin reads the ambient environment as its
 * highest-priority credential source, so anything Halo leaves in there becomes
 * a live credential for the model provider. Only what the runtime needs is
 * passed through.
 */

import path from 'path'
import { materializeCordisConfig } from './cordis-config'
import {
  describeMinNodeVersion,
  resolveDshInterpreter,
  resolveDshRuntime,
  resolveDshShell,
} from './resolve'
import { getSkillRoots } from '../../skills'
import type { ExternalMcpServer } from '../../mcp/types'
import type { DshRuntimeLaunchSpec } from '../types'

export interface DshLaunchOptions {
  /** Agent workspace: the session's working directory. */
  workDir: string
  /** Directory Halo owns for runtime state (cordis config, the runtime's home). */
  runtimeDataDir: string
  /**
   * Key the runtime sends to `baseUrl`. Halo's callers put the encoded
   * backend descriptor here rather than the provider's own key, because the
   * endpoint they point at is Halo's compat router (see `../options.ts`).
   */
  apiKey: string
  /**
   * Messages API root the runtime posts `/messages` under. Omit only when nothing
   * fronts the runtime and the adapter's shipped DeepSeek default is meant.
   */
  baseUrl?: string
  /**
   * The active model, when Halo judges it vision-capable. The runtime treats
   * every model it has no catalog entry for as text-only and swaps images for
   * placeholders, so this is what lets an image reach the model.
   */
  imageInputModel?: string
  /** Halo's host prompt, given to the runtime as its persona prefix. */
  persona?: string
  /**
   * Context capacity of the active model. Omit to leave the adapter's own
   * default, which is DeepSeek's 1M — on a smaller model that default puts the
   * compaction threshold beyond the window, so nothing ever compacts and the
   * conversation dies at the provider instead.
   */
  contextWindow?: number
  /**
   * Halo tool names this session may not use. The runtime has no per-call
   * approval channel, so the restriction is applied by composing a config
   * without those tools rather than by refusing them at call time.
   */
  disallowedTools?: readonly string[]
  /**
   * MCP servers the runtime should connect, already normalized. Halo's
   * in-process servers arrive here as loopback URLs; see `../options.ts`.
   */
  mcpServers?: Record<string, ExternalMcpServer>
}

/**
 * Environment variables inherited from Halo's own process. Restricted to what
 * Node and the runtime's subprocess/filesystem plugins need to function.
 */
const INHERITED_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot', 'TEMP', 'TMP']

export function buildDshLaunchSpec(options: DshLaunchOptions): DshRuntimeLaunchSpec {
  const runtime = resolveDshRuntime()
  if (!runtime) {
    throw new Error(
      '[Dsh][runtime] No dsh runtime found. The engine ships as a prebuilt bundle at ' +
        'resources/dsh-runtime — run "node runtimes/dsh/build.mjs", or switch ' +
        'config.agent.sdkEngine away from "dsh" and restart.'
    )
  }

  const interpreter = resolveDshInterpreter()
  if (!interpreter) {
    throw new Error(
      `[Dsh][runtime] No interpreter for the dsh runtime. It needs Node >= ${describeMinNodeVersion()}; ` +
        `this build's Electron bundles ${process.versions.node} and no new enough "node" was found on PATH. ` +
        'Install a current Node, set HALO_DSH_NODE to its path, or switch config.agent.sdkEngine away from "dsh".'
    )
  }

  const config = materializeCordisConfig(options.runtimeDataDir, {
    disallowedTools: options.disallowedTools,
    mcpServers: options.mcpServers,
    workDir: options.workDir,
  })

  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, interpreter.env)

  env.DEEPSEEK_API_KEY = options.apiKey
  if (options.baseUrl) {
    env.DEEPSEEK_BASE_URL = options.baseUrl
    // Web search holds its own endpoint and would otherwise send the key above
    // to DeepSeek's API whatever source is active; see the `web` row.
    env.DEEPSEEK_SEARCH_BASE_URL = options.baseUrl
  }

  // The runtime's home holds its credential store, anonymous user id and file
  // upload index. Left at `~/.dsh`, Halo's engine would read and write the
  // state of a separately installed dsh CLI.
  env.DSH_HOME = path.join(options.runtimeDataDir, 'home')
  env.DSH_CWD = options.workDir
  env.DSH_SKILL_DIRS = JSON.stringify(getSkillRoots(options.workDir))
  if (options.persona) env.DSH_SYSTEM_PROMPT = options.persona
  if (options.contextWindow) env.DSH_CONTEXT_WINDOW = String(options.contextWindow)
  if (options.imageInputModel) {
    env.DSH_MODEL_CATALOG = JSON.stringify([{ id: options.imageInputModel, inputModalities: ['text', 'image'] }])
  }
  Object.assign(env, config.env)

  const shell = resolveDshShell()
  if (shell) {
    env.DSH_SHELL_PATH = shell.path
    if (shell.pathPrepend) {
      env.PATH = env.PATH ? `${shell.pathPrepend}${path.delimiter}${env.PATH}` : shell.pathPrepend
    }
  } else {
    console.warn(
      '[Dsh][runtime] no bash found; the bash and terminal tools will fall back to PowerShell. ' +
        'Install Git Bash from Halo settings to run shell commands.'
    )
  }

  console.log(
    `[Dsh][runtime] launch spec entry=${runtime.entryPath} config=${config.path} ` +
      `interpreter=${interpreter.description} cwd=${options.workDir} ` +
      `shell=${shell?.path ?? '(none)'} ` +
      `baseUrl=${options.baseUrl ?? '(adapter default)'} ` +
      `apiKey=${options.apiKey ? 'set' : 'MISSING'} ` +
      `mcpServers=[${config.mcpServers.join(', ')}]`
  )

  return {
    command: interpreter.command,
    args: [runtime.entryPath, config.path],
    env,
    cwd: options.workDir,
  }
}
