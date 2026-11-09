/**
 * Activates optional capability context while preserving execution restrictions.
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
  const disabled = handlers.list().filter(s => s.configurable !== false && !s.open)
  const offList = disabled.map(s => `"${s.id}" — ${s.summary}`).join('\n')

  const requestTool = tool(
    'request_toolset',
    'Activate an available capability for this conversation when the task needs it. No human enablement is required. ' +
    'The available choices are:\n' + (offList || '(none)') + '\nUse the capability once its tools appear in the current session.',
    {
      name: z.string().describe('Capability id from the available choices.')
    },
    async (args: { name: string }) => {
      const result = handlers.request(args.name)
      if (!result.ok) return errorText(result.error ?? 'Failed to request capability')
      const label = result.displayName ?? args.name
      if (result.alreadyOpen) {
        return text(`"${label}" is already enabled — its tools (mcp__${args.name}__*) are available now.`)
      }
      return text(`Enabled "${label}". Use its tools after the session applies the updated capability set.`)
    }
  )

  console.log(`[Toolsets][${scope.conversationId}] Capabilities meta server created (${disabled.length} disabled)`)
  return createSdkMcpServer({
    name: CAPABILITIES_SERVER_NAME,
    version: '1.0.0',
    tools: [requestTool]
  })
}
