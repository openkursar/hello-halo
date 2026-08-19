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
  /** Directory Halo owns for runtime scratch (cordis config, session logs). */
  runtimeDataDir: string
  /** Credential for the OpenAI-compatible DeepSeek endpoint. */
  apiKey: string
  /** Endpoint override. Omit to use the adapter's shipped default. */
  baseUrl?: string
  /** Deployment persona injected as the runtime's system prompt. */
  systemPrompt?: string
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
      '[Dsh][runtime] No dsh runtime found. Expected @deepseek-ai/dsh-sdk-jsonrpc-demo and ' +
        '@deepseek-ai/dsh-sdk-jsonrpc-server to be installed. Install them, or switch ' +
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
  if (options.baseUrl) env.DEEPSEEK_BASE_URL = options.baseUrl

  env.DSH_CWD = options.workDir
  env.DSH_SESSION_ROOT = path.join(options.runtimeDataDir, 'sessions')
  env.DSH_SKILL_DIRS = JSON.stringify(getSkillRoots(options.workDir))
  if (options.systemPrompt) env.DSH_SYSTEM_PROMPT = options.systemPrompt
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
