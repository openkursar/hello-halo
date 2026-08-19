/**
 * Resolve Halo's SDK options into what the dsh runtime needs to be launched.
 *
 * The explicit resolve step the Codex adapter also has (`codex/options.ts`):
 * everything ambient — app config, the active AI source's credentials, Halo's
 * data directory — is read HERE and nowhere deeper, so the session adapter and
 * the normalizer stay free of global state and testable without a subprocess.
 *
 * dsh pins provider and model process-wide at `initialize`, so a resolved spec
 * describes exactly one runtime child process.
 */

import path from 'path'
import { app } from 'electron'
import { getConfig } from '../../../foundation/config.service'
import { getApiCredentials } from '../helpers'
import { partitionMcpServers } from '../mcp/partition'
import { SdkMcpBridge } from '../mcp/sdk-bridge'
import { buildDshLaunchSpec } from './runtime'
import { normalizeChatCompletionsBase, resolveDshModel } from './routing'
import type { ExternalMcpServer } from '../mcp/types'
import type { DshInitializeParams, DshRuntimeLaunchSpec } from './types'

export interface DshResolvedOptions {
  launch: DshRuntimeLaunchSpec
  init: DshInitializeParams
  includePartialMessages: boolean
  /**
   * Loopback server for Halo's in-process MCP tools, when the session has any.
   * Owned by `DshSession`: it must outlive the runtime child that dials it and
   * be closed with it.
   */
  mcpBridge?: SdkMcpBridge
  /** MCP server names the runtime was told to connect. */
  mcpServerNames: string[]
}

/**
 * The route the shipped cordis composition mounts. dsh addresses providers by
 * name, not by URL, so this must match `agent-default-model` in
 * `runtime/cordis-config.ts`.
 */
const DSH_PROVIDER = 'deepseek-official'

export async function resolveDshOptions(
  sdkOptions: Record<string, any>
): Promise<DshResolvedOptions> {
  const credentials = await getApiCredentials(getConfig())
  const workDir = sdkOptions.cwd || process.cwd()

  const { model, fellBack } = resolveDshModel(sdkOptions.model, credentials.model)
  if (fellBack) {
    console.warn(
      `[Dsh][options] model "${credentials.model || sdkOptions.model || '(none)'}" is not routable ` +
        `by the dsh runtime; falling back to ${model}`
    )
  }

  const baseUrl = normalizeChatCompletionsBase(credentials.baseUrl)
  console.log(
    `[Dsh][options] model=${model} endpoint=${baseUrl ? `${baseUrl}/chat/completions` : '(adapter default)'}`
  )

  // A restricted caller (an IM guest) arrives with the inverted whitelist its
  // policy produced. `allowedTools` is not read: Halo's callers use it to widen
  // an approval prompt, and this runtime has no prompt to widen.
  const disallowedTools = Array.isArray(sdkOptions.disallowedTools)
    ? (sdkOptions.disallowedTools as string[])
    : undefined
  if (disallowedTools?.length) {
    console.log(`[Dsh][options] restricted session: ${disallowedTools.length} tools denied`)
  }

  const { mcpServers, bridge } = await resolveMcpServers(sdkOptions.mcpServers)

  try {
    const launch = buildDshLaunchSpec({
      workDir,
      runtimeDataDir: path.join(app.getPath('userData'), 'dsh-runtime'),
      apiKey: credentials.apiKey,
      baseUrl,
      systemPrompt: sdkOptions.systemPrompt,
      disallowedTools,
      mcpServers,
    })

    return {
      launch,
      init: {
        cwd: workDir,
        provider: DSH_PROVIDER,
        model,
        ...(sdkOptions.maxTokens ? { maxTokens: sdkOptions.maxTokens as number } : {}),
      },
      includePartialMessages: sdkOptions.includePartialMessages !== false,
      mcpBridge: bridge,
      mcpServerNames: Object.keys(mcpServers),
    }
  } catch (err) {
    await bridge?.close().catch(() => {})
    throw err
  }
}

/**
 * Fold Halo's two kinds of MCP server into the one kind the runtime can dial.
 *
 * The runtime never issues a request back to Halo, so an in-process tool has no
 * inbound channel — but it does not need one: publishing those tools on
 * loopback turns them into ordinary MCP servers the runtime's own client
 * connects to, the same inversion the Codex adapter uses.
 */
async function resolveMcpServers(
  configured: Record<string, unknown> | undefined
): Promise<{ mcpServers: Record<string, ExternalMcpServer>; bridge?: SdkMcpBridge }> {
  const { sdk, external, unusable } = partitionMcpServers(configured)
  if (unusable.length > 0) {
    console.warn(`[Dsh][options] MCP servers Halo cannot describe: ${unusable.join(', ')}`)
  }

  const mcpServers: Record<string, ExternalMcpServer> = { ...external }
  if (Object.keys(sdk).length === 0) return { mcpServers }

  const bridge = new SdkMcpBridge(sdk)
  for (const [name, url] of Object.entries(await bridge.start())) {
    mcpServers[name] = { transport: 'http', url, headers: {} }
  }
  return { mcpServers, bridge }
}
