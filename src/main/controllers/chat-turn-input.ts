/**
 * What a chat client sends alongside a turn's text, checked at the transport
 * boundary for every chat entry (space chat, digital-human chat; IPC and HTTP
 * alike). Both the canvas context and the references are rendered into the
 * model's prompt, so they are rebuilt field by field with bounded sizes
 * rather than passed through.
 */

import { parseReferences } from '../../shared/content-reference'
import { isReasoningEffortLevel } from '../../shared/constants/reasoning-effort'
import type { CanvasContext } from '../../shared/types/canvas-context'
import type { ContentReference } from '../../shared/types/content-reference'
import type { ImageAttachment } from '../../shared/types/image-attachment'
import type { AppChatRequest } from '../apps/runtime'
import { resolveAppChatTarget } from './app-chat-target.controller'

const MAX_CANVAS_TABS = 50
const MAX_CANVAS_FIELD_CHARS = 500

function canvasField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, MAX_CANVAS_FIELD_CHARS) : undefined
}

function canvasTab(value: unknown): { type: string; title: string; url?: string; path?: string; terminalSessionId?: string } | null {
  if (!value || typeof value !== 'object') return null
  const tab = value as Record<string, unknown>
  if (typeof tab.type !== 'string' || typeof tab.title !== 'string') return null
  const url = canvasField(tab.url)
  const path = canvasField(tab.path)
  const terminalSessionId = canvasField(tab.terminalSessionId)
  return {
    type: tab.type.slice(0, MAX_CANVAS_FIELD_CHARS),
    title: tab.title.slice(0, MAX_CANVAS_FIELD_CHARS),
    ...(url ? { url } : {}),
    ...(path ? { path } : {}),
    ...(terminalSessionId ? { terminalSessionId } : {}),
  }
}

/**
 * The canvas context a client sent with a chat message, or undefined when it
 * is not one (said in the log: the turn then runs without it).
 */
export function parseCanvasContext(value: unknown): CanvasContext | undefined {
  if (value === undefined || value === null) return undefined
  const candidate = (typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (candidate.isOpen === false) return undefined
  const dropped = (reason: string): undefined => {
    console.warn(`[ChatInput] Canvas context dropped: ${reason}`)
    return undefined
  }
  if (candidate.isOpen !== true || !Number.isFinite(candidate.tabCount) || !Array.isArray(candidate.tabs)) {
    return dropped('not an open canvas with a tab count and a tab list')
  }

  const tabs: CanvasContext['tabs'] = []
  for (const raw of candidate.tabs.slice(0, MAX_CANVAS_TABS)) {
    const tab = canvasTab(raw)
    if (!tab) return dropped('a tab without a string type and title')
    tabs.push({ ...tab, isActive: (raw as { isActive?: unknown }).isActive === true })
  }
  const active = candidate.activeTab === null ? null : canvasTab(candidate.activeTab)
  if (active === null && candidate.activeTab !== null) return dropped('a malformed active tab')

  return {
    isOpen: true,
    tabCount: Math.min(Math.max(0, Math.trunc(candidate.tabCount as number)), MAX_CANVAS_TABS),
    activeTab: active,
    tabs,
  }
}

export type TurnReferencesResult =
  | { ok: true; references: ContentReference[] | undefined }
  | { ok: false; error: string }

/**
 * The references a client sent with a turn; undefined when there are none.
 * A malformed list refuses the turn (see `parseReferences`).
 */
export function parseTurnReferences(value: unknown): TurnReferencesResult {
  const parsed = parseReferences(value)
  if (!parsed.ok) return { ok: false, error: `Invalid references: ${parsed.error}` }
  return { ok: true, references: parsed.references.length > 0 ? parsed.references : undefined }
}

type AppChatInput = Partial<Record<keyof AppChatRequest, unknown>>

export type AppChatRequestResult =
  | { ok: true; request: AppChatRequest }
  | { ok: false; status: number; error: string }

/**
 * A person's message to a digital human, built field by field from what a
 * chat client sent — desktop IPC and remote HTTP alike. Who is speaking (the
 * team identity of a team session) is derived server-side by
 * `resolveAppChatTarget`; identity fields in the body (teamContext, an IM
 * sender, a recorded provenance) are never taken.
 */
export function toAppChatRequest(appId: string, body: unknown): AppChatRequestResult {
  const fields = (body && typeof body === 'object' ? body : {}) as AppChatInput
  const target = resolveAppChatTarget(appId, fields.conversationId)
  if (!target.ok) return target
  if (typeof fields.spaceId !== 'string' || !fields.spaceId) {
    return { ok: false, status: 400, error: 'Missing required field: spaceId' }
  }
  const references = parseTurnReferences(fields.references)
  if (!references.ok) return { ok: false, status: 400, error: references.error }
  const images = Array.isArray(fields.images) && fields.images.length > 0 ? fields.images as ImageAttachment[] : undefined
  // A message may be only images or the places the user pointed at.
  if (typeof fields.message !== 'string' || (fields.message.length === 0 && !references.references && !images)) {
    return { ok: false, status: 400, error: 'Missing required field: message' }
  }
  const canvasContext = parseCanvasContext(fields.canvasContext)
  return {
    ok: true,
    request: {
      appId,
      spaceId: fields.spaceId,
      message: fields.message,
      conversationId: target.conversationId,
      ...(images ? { images } : {}),
      ...(fields.thinkingEnabled !== undefined ? { thinkingEnabled: !!fields.thinkingEnabled } : {}),
      ...(isReasoningEffortLevel(fields.reasoningEffort) ? { reasoningEffort: fields.reasoningEffort } : {}),
      useChatThinkingLevel: true,
      ...(canvasContext ? { canvasContext } : {}),
      ...(references.references ? { references: references.references } : {}),
      ...(target.teamContext ? { teamContext: target.teamContext } : {}),
    },
  }
}
