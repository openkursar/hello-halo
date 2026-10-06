/**
 * Resolve Halo's SDK options into what the dsh runtime needs to be launched.
 *
 * The explicit resolve step the Codex adapter also has (`codex/options.ts`):
 * credentials are captured in the supplied SDK options; only process paths are
 * read here. The session adapter and normalizer stay free of global state and
 * testable without a subprocess.
 *
 * dsh pins provider and model process-wide at `initialize`, so a resolved spec
 * describes exactly one runtime child process.
 */

import path from 'path'
import { app } from 'electron'
import { encodeBackendConfig, ensureOpenAICompatRouter } from '../../../openai-compat-router'
import { credentialsToBackendConfig } from '../helpers'
import { getSdkApiCredentials } from '../sdk-config'
import { modelAcceptsImages } from '../image-attachments'
import { hostSystemPromptText } from '../system-prompt'
import { partitionMcpServers } from '../mcp/partition'
import { SdkMcpBridge } from '../mcp/sdk-bridge'
import { buildDshLaunchSpec } from './runtime'
import { resolveDshModel } from './routing'
import { clampModelRuntimeLimits } from '../../../../shared/constants/model-runtime-limits'
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
  const credentials = getSdkApiCredentials(sdkOptions)
  const workDir = sdkOptions.cwd || process.cwd()

  const { model, fellBack } = resolveDshModel(sdkOptions.model, credentials.model)
  if (fellBack) {
    console.warn(
      `[Dsh][options] model "${credentials.model || sdkOptions.model || '(none)'}" is not routable ` +
        `by the dsh runtime; falling back to ${model}`
    )
  }

  // The runtime addresses one endpoint with one key and builds every other
  // header itself, so a source's own headers and adapter have nowhere to ride
  // along. Halo's compat router is where a backend descriptor becomes a
  // request, so the runtime speaks Anthropic Messages to it and the descriptor
  // travels as the key. The runtime's own identity headers — a `User-Agent`
  // naming the DeepSeek harness, which some provider gateways refuse, and harness
  // tracking ids — never leave the child (see `runtimes/dsh/build.mjs`).
  const router = await ensureOpenAICompatRouter({ debug: false })
  const baseUrl = `${router.baseUrl}/v1`
  const backend = credentialsToBackendConfig(credentials)
  const apiKey = encodeBackendConfig(backend)

  // The runtime's DeepSeek adapter defaults to a 256K output cap and a 1M
  // context window — numbers only DeepSeek's own endpoint accepts. Any other
  // vendor behind an OpenAI-compatible gateway rejects the request on
  // `max_tokens` alone, and the compaction threshold derived from the window
  // (0.8 × window, see the compaction-basic row in `runtime/cordis-config.ts`)
  // would never fire before the real window overflowed. Halo's resolved
  // capabilities are what both knobs have to come from.
  const limits = clampModelRuntimeLimits(credentials.capabilities)
  const maxTokens = (sdkOptions.maxTokens as number | undefined) || limits.maxOutputTokens

  console.log(
    `[Dsh][options] model=${model} upstream=${credentials.baseUrl || '(none)'} via=${baseUrl} ` +
      `maxTokens=${maxTokens ?? '(runtime default)'} contextWindow=${limits.contextWindow ?? '(runtime default)'}`
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
      apiKey,
      baseUrl,
      persona: hostSystemPromptText(sdkOptions.systemPrompt) || undefined,
      ...(modelAcceptsImages(credentials) ? { imageInputModel: model } : {}),
      disallowedTools,
      mcpServers,
      ...(limits.contextWindow ? { contextWindow: limits.contextWindow } : {}),
    })

    return {
      launch,
      init: {
        cwd: workDir,
        provider: DSH_PROVIDER,
        model,
        ...(maxTokens ? { maxTokens } : {}),
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
