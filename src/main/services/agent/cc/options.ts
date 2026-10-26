import { partitionMcpServers } from '../mcp/partition'
import { SdkMcpBridge } from '../mcp/sdk-bridge'

export type CcOptions = Record<string, any>

/** The bridge belongs to the session, including when child startup fails. */
export async function prepareMcpServers(options: CcOptions): Promise<{
  servers: Record<string, unknown>
  bridge?: SdkMcpBridge
}> {
  const partition = partitionMcpServers(options.mcpServers)
  if (partition.unusable.length) {
    console.warn(`[CC] MCP configuration rejected: servers=${partition.unusable.join(',')} reason=no executable or URL`)
    throw new Error(`Unusable MCP server configuration: ${partition.unusable.join(', ')}`)
  }
  const servers: Record<string, unknown> = {}
  for (const [name, server] of Object.entries(partition.external)) {
    const { transport, ...configuration } = server
    servers[name] = { type: transport, ...configuration }
  }
  if (!Object.keys(partition.sdk).length) return { servers }
  const bridge = new SdkMcpBridge(partition.sdk)
  try {
    for (const [name, url] of Object.entries(await bridge.start())) servers[name] = { type: 'http', url }
    return { servers, bridge }
  } catch (error) {
    await bridge.close()
    throw error
  }
}

export function buildCcArguments(options: CcOptions, servers: Record<string, unknown>): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--replay-user-messages']
  const value = (flag: string, input: unknown) => {
    if (input !== undefined && input !== null) args.push(flag, String(input))
  }
  value('--model', options.model)
  value('--max-turns', options.maxTurns)
  value('--max-budget-usd', options.maxBudgetUsd)
  value('--effort', options.effort)
  value('--resume', options.resume)
  value('--session-id', options.sessionId)
  value('--permission-mode', options.permissionMode)
  value('--fallback-model', options.fallbackModel)
  value('--resume-session-at', options.resumeSessionAt)
  if (options.canUseTool) args.push('--permission-prompt-tool', 'stdio')
  if (options.includePartialMessages) args.push('--include-partial-messages')
  if (options.continue) args.push('--continue')
  if (options.forkSession) args.push('--fork-session')
  if (options.persistSession === false) args.push('--no-session-persistence')
  if (options.allowDangerouslySkipPermissions) args.push('--allow-dangerously-skip-permissions')
  if (options.strictMcpConfig) args.push('--strict-mcp-config')
  if (options.includeHookEvents) args.push('--include-hook-events')
  for (const [key, flag] of [['allowedTools', '--allowedTools'], ['disallowedTools', '--disallowedTools'], ['betas', '--betas']] as const) {
    if (options[key]?.length) args.push(flag, options[key].join(','))
  }
  if (options.tools !== undefined) args.push('--tools', Array.isArray(options.tools) ? options.tools.join(',') : 'default')
  if (options.settingSources !== undefined) args.push(`--setting-sources=${options.settingSources.join(',')}`)
  if (Object.keys(servers).length) args.push('--mcp-config', JSON.stringify({ mcpServers: servers }))
  for (const directory of options.additionalDirectories ?? []) args.push('--add-dir', directory)
  for (const plugin of options.plugins ?? []) {
    if (plugin.type !== 'local') throw new Error(`Unsupported CC plugin type: ${plugin.type}`)
    args.push('--plugin-dir', plugin.path)
  }
  const thinking = options.thinking
  if (thinking?.type === 'disabled') args.push('--thinking', 'disabled')
  else if (thinking?.type === 'adaptive' || (thinking?.type === 'enabled' && thinking.budgetTokens == null)) args.push('--thinking', 'adaptive')
  else value('--max-thinking-tokens', thinking?.budgetTokens ?? options.maxThinkingTokens)
  for (const [flag, argument] of Object.entries(options.extraArgs ?? {})) {
    args.push(`--${flag}`)
    if (argument !== null) args.push(String(argument))
  }
  return args
}
