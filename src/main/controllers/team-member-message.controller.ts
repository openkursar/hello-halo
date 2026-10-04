/**
 * The text of a person's message to one team member, built at the transport
 * boundary (desktop IPC and HTTP alike).
 *
 * The team's message bus carries text only — that is how it reaches a member
 * on another machine — so the places the person pointed at are written after
 * their words, as the model reads them in a local turn. Paths inside the space
 * they pointed from are shown relative to its folder.
 */

import { formatReferencesBlock, getWorkingDir } from '../services/agent'
import { parseTurnReferences } from './chat-turn-input'

export type MemberMessageResult = { ok: true; message: string } | { ok: false; error: string }

export function toMemberMessage(input: { message?: unknown; references?: unknown; spaceId?: unknown }): MemberMessageResult {
  const references = parseTurnReferences(input.references)
  if (!references.ok) return references
  const text = typeof input.message === 'string' ? input.message : ''
  if (!references.references) return { ok: true, message: text }
  const workDir = typeof input.spaceId === 'string' && input.spaceId ? getWorkingDir(input.spaceId) : undefined
  const block = formatReferencesBlock(references.references, workDir).trimEnd()
  return { ok: true, message: text ? `${text}\n\n${block}` : block }
}
