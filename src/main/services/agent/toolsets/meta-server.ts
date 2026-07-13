/**
 * Toolset Broker - "capabilities" meta MCP server
 *
 * A single resident tool — `request_toolset` — present ONLY when at least one
 * optional capability (ai-terminal / ai-browser) is currently disabled. It lets
 * the AI ask the user to enable a disabled capability (the AI cannot enable one
 * itself: tools are frozen per turn, so a mid-turn open would be unusable). The
 * tool is self-documenting: its description lists exactly which capabilities are
 * off, so no extra system-prompt index is needed. Calling it highlights that
 * capability's switch in the input "Tools" menu.
 *
 * Deliberately NOT a generic "toolsets"/"MCP manager" surface — it governs only
 * the handful of optional, user-gated capabilities, and disappears once they are
 * all enabled.
 *
 * Handlers are injected by broker.ts to avoid a module cycle.
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from '../resolved-sdk'
import type { RequestToolsetResult } from './broker'
import type { ToolsetScope, ToolsetStatus } from './types'

export const CAPABILITIES_SERVER_NAME = 'capabilities'

export interface BrokerMetaHandlers {
  list: () => ToolsetStatus[]
  request: (toolsetId: string) => RequestToolsetResult
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const errorText = (value: string) => ({ content: [{ type: 'text' as const, text: value }], isError: true })

export function createBrokerMetaServer(scope: ToolsetScope, handlers: BrokerMetaHandlers) {
  const disabled = handlers.list().filter(s => !s.open)
  const offList = disabled.map(s => `"${s.id}" — ${s.summary}`).join('\n')

  const requestTool = tool(
    'request_toolset',
    'Some optional capabilities are turned OFF, and you CANNOT enable them yourself — only the user can, ' +
    'via the input "Tools" menu.\n\n' +
    'Currently off:\n' + (offList || '(none)') + '\n\n' +
    'When a task needs one of these (or the user asks for it), call this tool IMMEDIATELY with its id. ' +
    'Do NOT ask the user for permission to call it, and do NOT merely explain that you cannot — ' +
    'calling this IS how you help: it highlights that capability\'s switch in the "Tools" menu. ' +
    'After calling, tell the user in ONE short line to flip the highlighted switch; its tools become ' +
    'available from their next message. Do not attempt the capability\'s tools until it is enabled.',
    {
      name: z.string().describe('Capability id to request, e.g. "ai-terminal" or "ai-browser"')
    },
    async (args: { name: string }) => {
      const result = handlers.request(args.name)
      if (!result.ok) return errorText(result.error ?? 'Failed to request capability')
      const label = result.displayName ?? args.name
      if (result.alreadyOpen) {
        return text(`"${label}" is already enabled — its tools (mcp__${args.name}__*) are available now.`)
      }
      return text(
        `Asked the user to enable "${label}" (highlighted in the Tools menu). ` +
        `Tell them to turn it on; its tools (mcp__${args.name}__*) will be available from their next message.`
      )
    }
  )

  console.log(`[Toolsets][${scope.conversationId}] Capabilities meta server created (${disabled.length} disabled)`)
  return createSdkMcpServer({
    name: CAPABILITIES_SERVER_NAME,
    version: '1.0.0',
    tools: [requestTool]
  })
}
