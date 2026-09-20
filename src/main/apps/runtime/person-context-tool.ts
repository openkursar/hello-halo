import { z } from 'zod'
import { tool, createSdkMcpServer } from '../../services/agent/resolved-sdk'
import type { PersonContextCaller } from '../../../shared/apps/person-context'
import { readPersonContext } from './person-context'

export function createPersonContextTool(caller: PersonContextCaller) {
  return tool('read_digital_human_context',
    'Read current digital human team memberships, roles, one permitted team task, or capability availability. Read-only; does not wake agents. References are rendered as navigation buttons. Caller scope is enforced by the runtime; private chats are never returned.',
    {
      appId: z.string().optional().describe('Required for the space assistant; a digital human can read only itself.'),
      section: z.enum(['teams', 'work', 'capabilities']),
      offset: z.number().int().min(0).optional(),
      teamId: z.string().optional(),
      epochId: z.string().optional(),
    }, async query => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(readPersonContext(caller, query)) }] }
      } catch (error) {
        console.warn(`[PersonContext] Query rejected: caller=${caller.authority}, app=${caller.appId ?? query.appId ?? 'none'}, section=${query.section}:`, error)
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }
      }
    })
}

export function createPersonContextMcpServer(caller: PersonContextCaller) {
  return createSdkMcpServer({ name: 'halo-person-context', version: '1.0.0', tools: [createPersonContextTool(caller)] })
}

export function personContextPrompt(caller: PersonContextCaller): string {
  return `## Current identity and access\nDigital human ID: ${caller.appId ?? 'none (space assistant)'}. Caller: ${caller.authority}.` +
    (caller.teamId ? ` Current team: ${caller.teamId}; task: ${caller.epochId ?? 'none'}.` : '') +
    '\nUse read_digital_human_context when asked about relationships, roles or permitted work; do not infer them from memory. Returned references are navigation targets, not permission to act. last_synced is a replica, not proof of live reachability. Capability access describes configuration for the next turn, not tools already loaded or a successful connection test. Chat inherits workspace connections; independent runs use declared connections. Never claim the space assistant is the digital human being queried.'
}
