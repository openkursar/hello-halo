/**
 * Agent Module - Permission Handler
 *
 * canUseTool is reached only by a tool call the engine did not already settle:
 *   - allowedTools:    rules that auto-allow (a bare tool name, or a command
 *                      pattern like `Bash(npm run:*)`, which the engine matches
 *                      against every part of a compound command)
 *   - disallowedTools: removed from the model's pool entirely
 * A session running with permissions bypassed settles everything up front, so
 * only the interactive tools arrive here.
 *
 * Two things therefore happen in this callback: AskUserQuestion pauses the turn
 * and waits for an answer over IPC, and — when the caller supplied a `gate` —
 * anything the engine left undecided is put to that gate. The gate is how a
 * turn driven by somebody other than the owner is held to what the owner
 * granted; this module never learns what the policy says, only whom to ask.
 */

import { emitAgentEvent } from './events'

// ============================================
// Types
// ============================================

type PermissionResult = {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
} | {
  behavior: 'deny'
  message: string
}

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal }
) => Promise<PermissionResult>

/**
 * The owner's answer for one tool call, asked per call rather than per session.
 *
 * Supplied by whoever knows what "allowed" means for this turn (apps/runtime's
 * delegation gate). Returning `allow: false` refuses the call and tells the
 * model why, so it reads as a closed door rather than a tool failure to retry.
 */
export type ToolGate = (
  toolName: string,
  input: Record<string, unknown>
) => { allow: boolean; reason?: string }

interface CanUseToolDeps {
  spaceId: string
  conversationId: string
  /**
   * Non-interactive mode: tools that require real-time user interaction
   * (e.g. AskUserQuestion) are immediately denied.
   *
   * Use this for any session where the user cannot respond to interactive
   * prompts — IM channels, scheduled runs, headless API calls, etc.
   */
  nonInteractive?: boolean
  /**
   * Consulted for every tool call the engine did not auto-allow. Absent = the
   * historical behaviour (auto-allow), which is what an owner's own session
   * runs with. A session that MAY host a borrowed turn installs one; the gate
   * itself stays inert until a turn registers a policy, so installing it costs
   * an unrestricted turn nothing.
   */
  gate?: ToolGate
}

// ============================================
// Pending Questions Registry
// ============================================

/** A single AskUserQuestion item, as supplied by the model. */
export interface AskUserQuestionItem {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiSelect: boolean
}

/**
 * Recoverable snapshot of an in-flight question, used by remote/mobile clients
 * to rebuild the AskUserQuestion card after a reconnect or page refresh (the
 * original `agent:ask-question` event is a one-shot push that disconnected
 * clients miss).
 */
export interface RecoverablePendingQuestion {
  id: string
  questions: AskUserQuestionItem[]
}

interface PendingQuestionEntry {
  resolve: (answers: Record<string, string>) => void
  reject: (reason?: unknown) => void
  /** Owning conversation, for recovery lookups by conversationId. */
  conversationId: string
  /** Original question payload, replayed verbatim on recovery. */
  questions: AskUserQuestionItem[]
}

/** Map of question ID -> Promise handlers. Module-level for IPC handler access. */
const pendingQuestions = new Map<string, PendingQuestionEntry>()

/**
 * The active (still-unanswered) question for a conversation, or null. A returned
 * entry is always awaiting an answer since resolve/reject/abort all delete it.
 * At most one is active per conversation — the turn blocks before asking again.
 */
export function getActivePendingQuestion(conversationId: string): RecoverablePendingQuestion | null {
  for (const [id, entry] of pendingQuestions) {
    if (entry.conversationId === conversationId) {
      return { id, questions: entry.questions }
    }
  }
  return null
}

/**
 * Resolve a pending question with user answers.
 * Called by IPC handler when user submits answers.
 */
export function resolveQuestion(id: string, answers: Record<string, string>): boolean {
  const entry = pendingQuestions.get(id)
  if (!entry) {
    console.warn(`[PermissionHandler] No pending question found for id: ${id}`)
    return false
  }
  entry.resolve(answers)
  pendingQuestions.delete(id)
  return true
}

/**
 * Reject a pending question (e.g., user sends new message, cancels).
 * Called when the question should be abandoned.
 */
export function rejectQuestion(id: string, reason?: string): boolean {
  const entry = pendingQuestions.get(id)
  if (!entry) return false
  entry.reject(new Error(reason || 'Question cancelled'))
  pendingQuestions.delete(id)
  return true
}

/**
 * Reject all pending questions for a given conversation.
 * Used when stop generation is triggered or user sends a new message.
 */
export function rejectAllQuestions(): void {
  for (const [id, entry] of pendingQuestions) {
    entry.reject(new Error('Generation stopped'))
    pendingQuestions.delete(id)
  }
}

// ============================================
// Permission Handler Factory
// ============================================

/**
 * Create tool permission handler.
 *
 * Most tools are handled by CLI internally (via dangerously-skip-permissions).
 * This callback is only invoked for special tools like ExitPlanMode/EnterPlanMode
 * that the CLI cannot decide on its own.
 *
 * Special case: AskUserQuestion tool pauses execution, sends questions to the
 * renderer via IPC, waits for user answers, then returns the answers as updatedInput.
 *
 * @param deps - Optional dependencies for AskUserQuestion support.
 *               When not provided, AskUserQuestion calls are auto-allowed without answers.
 */
export function createCanUseTool(deps?: CanUseToolDeps): CanUseToolFn {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal }
  ): Promise<PermissionResult> => {
    // Anything but AskUserQuestion is a call the engine left undecided: put it
    // to the gate when there is one, and otherwise keep the owner's fast path.
    if (toolName !== 'AskUserQuestion') {
      const verdict = deps?.gate?.(toolName, input)
      if (verdict && !verdict.allow) {
        return {
          behavior: 'deny' as const,
          message: verdict.reason || `"${toolName}" is not available for this request.`,
        }
      }
      return { behavior: 'allow' as const, updatedInput: input }
    }

    // AskUserQuestion: if no deps provided (e.g., warmup), allow with empty answers
    if (!deps) {
      console.warn('[PermissionHandler] AskUserQuestion called without deps, auto-allowing')
      return { behavior: 'allow' as const, updatedInput: { ...input, answers: {} } }
    }

    // Non-interactive sessions cannot respond to interactive tools — deny immediately
    if (deps.nonInteractive) {
      console.log(`[PermissionHandler] AskUserQuestion denied: non-interactive session (conversationId=${deps.conversationId})`)
      return {
        behavior: 'deny' as const,
        message: 'Question skipped: this session runs unattended and cannot wait for an answer.'
      }
    }

    const { spaceId, conversationId } = deps
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const questions = (input.questions as AskUserQuestionItem[]) ?? []

    console.log(`[PermissionHandler] AskUserQuestion: id=${id}, questions=${questions?.length || 0}`)

    // Create promise that will be resolved by IPC handler
    const answersPromise = new Promise<Record<string, string>>((resolve, reject) => {
      pendingQuestions.set(id, { resolve, reject, conversationId, questions })

      // Clean up on abort (user stops generation)
      if (options.signal) {
        const onAbort = () => {
          if (pendingQuestions.has(id)) {
            pendingQuestions.delete(id)
            reject(new Error('Aborted'))
          }
        }
        if (options.signal.aborted) {
          onAbort()
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true })
        }
      }
    })

    // Send questions to renderer via event emitter
    emitAgentEvent('agent:ask-question', spaceId, conversationId, {
      id,
      questions: questions || []
    })

    try {
      // Wait for user answer
      const answers = await answersPromise
      console.log(`[PermissionHandler] AskUserQuestion answered: id=${id}`, answers)
      return {
        behavior: 'allow' as const,
        updatedInput: { ...input, answers }
      }
    } catch (error) {
      // Question was cancelled or aborted
      console.log(`[PermissionHandler] AskUserQuestion cancelled: id=${id}`, (error as Error).message)
      return {
        behavior: 'deny' as const,
        message: 'Question cancelled: the user stopped generation before answering.'
      }
    }
  }
}
