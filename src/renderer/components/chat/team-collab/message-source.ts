/**
 * Classification of team-collaboration messages delivered into the space
 * conversation that coordinates them.
 *
 * A member's message is persisted as `role: 'system'` — never `'user'` — so
 * the model cannot read a teammate as its owner speaking; the renderer keeps
 * the same distinction visible. These predicates are the single place that
 * decides the rendering family.
 */

import type { Message } from '../../../types'

export interface TeamMessageProvenance {
  teamId: string
  teamName: string
  /** Null for system-authored notices (turn-end reports). */
  fromMemberName: string | null
}

export function isTeamMessage(message: Message): boolean {
  // Provenance is required: without a teamId the team bubble has nothing to
  // render, so the message falls back to the default bubble instead of vanishing.
  return message.role === 'system' && message.source === 'team-message' && readTeamProvenance(message) !== null
}

export function readTeamProvenance(message: Message): TeamMessageProvenance | null {
  const meta = message.metadata
  if (!meta?.teamId) return null
  return {
    teamId: meta.teamId,
    teamName: meta.teamName || '',
    fromMemberName: meta.fromMemberName ?? null,
  }
}
