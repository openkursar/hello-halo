/**
 * Conversation goal — what the current work must achieve and how to tell it is
 * done. Held by the agent engine per session (only engines whose capabilities
 * advertise `features.goal`); main mirrors it to the renderer, which never
 * stores it on its own.
 *
 * Shapes match the engine's own goal record so a value passes through
 * unchanged. Pure data, renderer-safe.
 */

/** Only an `active` goal steers the agent. */
export type GoalStatus = 'active' | 'complete' | 'abandoned'

/** `agent`: the model changed it through its Goal tool. `user`: set from Halo on the user's behalf. */
export type GoalChangeSource = 'agent' | 'user'

export interface Goal {
  objective: string
  /** Checkable criteria that together mean the objective is met. */
  doneWhen: string[]
  status: GoalStatus
  /** Context recorded with the latest change, e.g. why it was completed or abandoned. */
  note?: string
  updatedBy: GoalChangeSource
  /** ISO-8601 */
  updatedAt: string
}

/** What the user supplies when setting or replacing a goal. */
export interface GoalInput {
  objective: string
  doneWhen?: string[]
}

/** Payload of the `agent:goal-updated` event. `goal` is null when the goal was removed. */
export interface GoalUpdatedEvent {
  spaceId: string
  conversationId: string
  goal: Goal | null
  source: GoalChangeSource
  /**
   * False when Halo announces a user change it just handed to the engine; true
   * when the engine reports a change the model has seen (its own, or a user
   * change it picked up at the start of a step).
   */
  seenByModel: boolean
}
