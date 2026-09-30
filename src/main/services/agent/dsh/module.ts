/**
 * dsh engine facade implementing Halo's SDK module contract.
 *
 * `resolved-sdk.ts` calls this factory during `initSdk()`. The session adapter
 * owns the runtime child process, so the factory itself starts nothing — a
 * runtime is spawned on the first `createSession()`.
 *
 * This is the one place that composes both halves of the adapter: it registers
 * the transport's client factory into the session half's
 * `setDshRuntimeClientFactory()` seam, and it runs the `resolveDshOptions()`
 * step that turns Halo's SDK options into a launch spec. Neither half reads
 * ambient state on its own.
 */

import { DshSession, setDshRuntimeClientFactory } from './session-adapter'
import { tool, createSdkMcpServer } from '../mcp/sdk-server'
import { DSH_CAPABILITIES } from './capabilities'
import { resolveDshOptions } from './options'
import { createDshRuntimeClient } from './transport'
import type { DshSdkModule } from './types'

setDshRuntimeClientFactory((launch) => createDshRuntimeClient({ launch }))

export function createDshSdkModule(): DshSdkModule {
  return {
    tool,
    createSdkMcpServer,
    capabilities: DSH_CAPABILITIES,
    async createSession(options: Record<string, any>) {
      return createSession(options)
    },
    query(params: any) {
      return queryDsh(params)
    },
  }
}

/**
 * Resolve, then hand the session everything it owns for the rest of its life.
 *
 * Resolution starts the MCP bridge, so a failure between here and the session
 * taking ownership would leave a listening socket with nothing to close it.
 */
async function createSession(options: Record<string, any>): Promise<DshSession> {
  const resolved = await withResolvedRuntime(options)
  try {
    return await DshSession.create(resolved)
  } catch (err) {
    await resolved.mcpBridge?.close().catch(() => {})
    throw err
  }
}

/**
 * Fold the resolved launch spec back into the SDK options the session adapter
 * reads, so the adapter keeps one input shape whether it is driven by Halo or
 * by a test that supplies its own spec.
 *
 * Every field of the resolved `initialize` params has to appear here: the
 * adapter rebuilds those params from these options, so one left out is one the
 * runtime is never told about, and it silently keeps its own default instead.
 */
async function withResolvedRuntime(options: Record<string, any>): Promise<Record<string, any>> {
  const resolved = await resolveDshOptions(options)
  return {
    ...options,
    command: resolved.launch.command,
    args: resolved.launch.args,
    env: resolved.launch.env,
    cwd: resolved.init.cwd,
    provider: resolved.init.provider,
    model: resolved.init.model,
    maxTokens: resolved.init.maxTokens,
    includePartialMessages: resolved.includePartialMessages,
    mcpBridge: resolved.mcpBridge,
    mcpServerNames: resolved.mcpServerNames,
  }
}

async function* queryDsh(params: any): AsyncGenerator<any> {
  const session = await createSession(params?.options || {})
  try {
    session.send(params?.prompt || 'hi')
    yield* session.stream()
  } finally {
    await session.close()
  }
}
