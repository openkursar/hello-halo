/**
 * What the model is told about organization sign-in: whether it works, which
 * organization tools it can use now, and how the user signs in. Sent as a
 * system reminder only when it differs from what the conversation was last
 * told, so a conversation reads it once and again after each change. Built
 * only from host-owned state: no account id, no ticket or code, provider and
 * tool names cleaned and bounded.
 */
import type { OrgSignInState } from '../../../shared/types/enterprise-identity'
import type { EngineId } from '../../../shared/types/engine'
import { peekEnterpriseIdentityState } from '../enterprise-identity'
import { peekOrganizationTools, type OrganizationTool } from '../cli-tools'
import { opensWithSlashCommand } from './opening-context'

const MAX_NAME = 40
const MAX_TOOLS = 10
/** Conversations whose last reminder is remembered; the oldest is forgotten first and simply told again. */
const MAX_CONVERSATIONS = 500

const SIGN_IN_HINT = 'ask the user to sign in from the organization icon beside the send button in Halo on the desktop. Never ask for passwords or tokens.'

const told = new Map<string, string>()

function clean(text: string, max: number): string {
  return text.replace(/[<>&\r\n\t`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function toolList(tools: readonly OrganizationTool[]): string {
  const shown = tools.slice(0, MAX_TOOLS).map(tool => `${tool.skillName} (${clean(tool.name, MAX_NAME) || tool.toolId})`)
  const more = tools.length - shown.length
  return more > 0 ? `${shown.join(', ')}, and ${more} more in the skill list` : shown.join(', ')
}

/**
 * The reminder text, or '' when there is nothing reliable to say: no
 * organization sign-in, or its state is still loading, restoring or
 * unavailable (never reported as signed out).
 */
export function formatOrgStatus(state: OrgSignInState | null, tools: readonly OrganizationTool[]): string {
  if (!state || state.status === 'unconfigured') return ''
  const name = clean(state.name || 'Organization', MAX_NAME) || 'Organization'
  if (state.withdrawalPending) {
    return `${name} sign-in: organization access is in an unsettled state. Do not rely on organization access; ask the user to press Retry in Halo's organization sign-in on the desktop.`
  }
  if (state.status === 'signed-out') {
    return [
      `${name} sign-in: not signed in.`,
      tools.length > 0
        ? `Organization tools that need it: ${toolList(tools)}. Before using them, ${SIGN_IN_HINT}`
        : `If a task needs organization access, ${SIGN_IN_HINT}`,
    ].join('\n')
  }
  if (state.status !== 'active') return ''
  const lacking = state.capabilities
    .filter(capability => capability.status !== 'ready')
    .slice(0, MAX_TOOLS)
    .map(capability => `${clean(capability.label || capability.id, MAX_NAME)} ${capability.status === 'expired' ? 'expired' : 'not signed in'}`)
  const lines = [`${name} sign-in: signed in${lacking.length > 0 ? `; ${lacking.join('; ')}` : ''}.`]
  if (tools.length > 0) {
    lines.push(`Organization tools ready to use: ${toolList(tools)}.`, 'For these tasks use their skills first, unless the user names another tool.')
  }
  if (lacking.length > 0) lines.push(`If a task needs one of the missing ones, ${SIGN_IN_HINT}`)
  return lines.join('\n')
}

function reminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`
}

function remember(key: string, text: string): void {
  told.delete(key)
  told.set(key, text)
  if (told.size > MAX_CONVERSATIONS) told.delete(told.keys().next().value!)
}

function currentStatus(): string {
  return formatOrgStatus(peekEnterpriseIdentityState(), peekOrganizationTools())
}

/** One conversation, as every entry point and its session hooks name it. */
export function orgConversationKey(spaceId: string | null | undefined, conversationId: string): string {
  return `${spaceId ?? ''}\u0000${conversationId}`
}

/**
 * The reminder ahead of an owner's turn: empty unless the conversation has not
 * been told the current status. Call `delivered` once the engine accepted the
 * turn, so a failed send tells it again next time. Reads memory only.
 */
export function prepareOrgReminder(key: string, message: string): { context: string; delivered(): void } {
  const text = opensWithSlashCommand(message) ? '' : currentStatus()
  if (!text || told.get(key) === text) return { context: '', delivered() {} }
  return { context: `${reminder(text)}\n\n`, delivered: () => remember(key, text) }
}

/**
 * Session hooks that keep the status current between the user's turns: after
 * a shell command (which is how organization tools run) when it changed, and
 * across compaction. The Halo engine carries compaction context forward; for
 * other engines the next turn tells the status again. None without
 * organization sign-in.
 */
export function orgReminderHooks(key: string, engineId: EngineId): Record<string, unknown[]> | undefined {
  if (peekEnterpriseIdentityState().status === 'unconfigured') return undefined
  return {
    PostToolUse: [{
      matcher: 'Bash',
      hooks: [async () => {
        const text = currentStatus()
        if (!text || told.get(key) === text) return {}
        remember(key, text)
        return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reminder(text) } }
      }],
    }],
    PreCompact: [{
      hooks: [async () => {
        const text = engineId === 'halo' ? currentStatus() : ''
        if (!text) {
          told.delete(key)
          return {}
        }
        remember(key, text)
        return { additionalContext: text }
      }],
    }],
  }
}
