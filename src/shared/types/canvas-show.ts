/**
 * The AI asking every client to bring something in front of the user
 * (`canvas_show`), and each client's answer. Shared by the main-process
 * service, the IPC/HTTP/WebSocket transport and the renderer.
 */

export type CanvasShowTarget =
  | { kind: 'page'; viewId: string; url: string | null; title: string | null }
  | { kind: 'terminal'; sessionId: string; title: string }
  | { kind: 'file'; path: string }

export interface CanvasShowRequest {
  requestId: string
  replyWithinMs: number
  spaceId: string
  /** The conversation whose AI asked; only a client showing it may switch the screen. */
  conversationId: string
  target: CanvasShowTarget
  /** False once this target was already brought forward in the current reply: only keep its tab. */
  bringForward: boolean
}

/**
 * What one client can confirm: the target is visible (`shown`), its tab was
 * selected but visibility was not confirmed (`opened`), its tab was kept
 * without switching (`added`), or no tab could be kept (`unavailable`).
 */
export type CanvasShowClientOutcome = 'shown' | 'opened' | 'added' | 'unavailable'

export interface CanvasShowReply {
  requestId: string
  outcome: CanvasShowClientOutcome
}
