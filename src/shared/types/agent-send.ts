/**
 * What a chat client sends to start a space-chat turn or to add to the one
 * running. One shape for every surface that carries it (preload, renderer
 * api, IPC handler, HTTP route); the main process checks it at the boundary
 * (controllers/agent.controller) before anything is recorded.
 */

import type { ReasoningEffortLevel } from '../constants/reasoning-effort'
import type { CanvasContext } from './canvas-context'
import type { ContentReference } from './content-reference'
import type { GoalInput } from './goal'
import type { ImageAttachment } from './image-attachment'

export interface AgentSendRequest {
  spaceId: string
  conversationId: string
  /** May be empty when images or references carry the message. */
  message: string
  resumeSessionId?: string
  images?: ImageAttachment[]
  thinkingEnabled?: boolean
  /** Depth picked for this send; overrides thinkingEnabled. */
  reasoningEffort?: ReasoningEffortLevel
  /** Run as a "chat with this knowledge base" turn. */
  knowledgeBaseId?: string
  /** Set as the conversation goal before this message runs. */
  goal?: GoalInput
  /** What the user has open in the canvas. */
  canvasContext?: CanvasContext
  /** Places the user pointed at, in the order they added them. */
  references?: ContentReference[]
}

export interface AgentInjectRequest {
  conversationId: string
  /** May be empty when references carry the message. */
  message: string
  references?: ContentReference[]
}
