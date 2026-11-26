/**
 * The organization sign-in block that rides ahead of a turn's message, so the
 * model knows which organization capabilities work right now and how the user
 * signs in. Built only from host-owned state: no account id, no provider text
 * beyond its bounded display name, no ticket or code.
 */
import type { OrgSignInState } from '../../../shared/types/enterprise-identity'
import { peekEnterpriseIdentityState } from '../enterprise-identity'
import { opensWithSlashCommand } from './opening-context'

const MAX_NAME = 40
const MAX_BLOCK = 600

function clean(text: string, max: number): string {
  return text.replace(/[<>&\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * Empty when there is nothing reliable to say: no organization sign-in, or its
 * state is still loading, restoring or unavailable (never reported as signed out).
 */
export function formatOrgContext(state: OrgSignInState | null): string {
  if (!state || state.status === 'unconfigured') return ''
  const name = clean(state.name || 'Organization', MAX_NAME) || 'Organization'
  if (state.withdrawalPending) {
    return `<halo_org>\n${name} sign-in: organization access is in an unsettled state. Do not rely on organization access; ask the user to press Retry in Halo's organization sign-in on the desktop.\n</halo_org>\n\n`
  }
  if (state.status !== 'signed-out' && state.status !== 'active') return ''
  const hint = state.status === 'signed-out' || state.capabilities.some(c => c.status !== 'ready')
    ? 'If a task needs one of these, ask the user to sign in from the organization icon beside the send button in Halo on the desktop. Never ask for passwords or tokens.'
    : ''
  // Rules are reserved first; capabilities are added whole until the budget runs out.
  const fixed = ['<halo_org>', hint, '</halo_org>'].join('\n').length + 2
  let status: string
  if (state.status === 'signed-out') {
    status = `${name} sign-in: not signed in.`
  } else {
    let budget = MAX_BLOCK - fixed - name.length - 16
    const parts: string[] = []
    for (const c of state.capabilities) {
      const label = clean(c.label || c.id, MAX_NAME)
      const part = `${label} ${c.status === 'ready' ? 'available' : c.status === 'expired' ? 'expired' : 'not signed in'}`
      if (part.length + 2 > budget) { parts.push('…'); break }
      budget -= part.length + 2
      parts.push(part)
    }
    status = `${name} sign-in: ${parts.join('; ')}.`
  }
  const lines = [status, hint].filter(Boolean)
  return `<halo_org>\n${lines.join('\n')}\n</halo_org>\n\n`
}

/**
 * The block for a turn the owner started. Reads the state already held in
 * memory; never loads the provider or checks the sign-in.
 */
export function orgTurnContext(message: string): string {
  return opensWithSlashCommand(message) ? '' : formatOrgContext(peekEnterpriseIdentityState())
}
