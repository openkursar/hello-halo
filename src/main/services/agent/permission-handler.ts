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
  options: { signal: AbortSignal; toolUseID?: string }
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
  const answerCount = answers && typeof answers === 'object' && !Array.isArray(answers) ? Object.keys(answers).length : 0
  const reason = !answerCount ? 'empty-answers'
    : answerCount !== entry.questions.length ? 'answer-count-mismatch'
    : entry.questions.some(question => !Object.hasOwn(answers, question.question)) ? 'question-key-mismatch'
    : entry.questions.some(question => typeof answers[question.question] !== 'string' || !answers[question.question].trim()) ? 'blank-answer'
    : null
  if (reason) {
    console.warn(`[PermissionHandler] AskUserQuestion submission rejected: id=${id}, conversationId=${entry.conversationId}, reason=${reason}, expected=${entry.questions.length}, received=${answerCount}`)
    return false
  }
  pendingQuestions.delete(id)
  entry.resolve(answers)
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
 *               When absent, interactive questions are denied.
 */
export function createCanUseTool(deps?: CanUseToolDeps): CanUseToolFn {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID?: string }
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

    if (!deps) {
      console.warn('[PermissionHandler] AskUserQuestion rejected: reason=no-answer-channel')
      return { behavior: 'deny', message: 'No user answer channel is available. Ask the user in your reply instead.' }
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
    const questions = input.questions as AskUserQuestionItem[] | undefined
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4
      || questions.some(question => !question || typeof question.question !== 'string' || !question.question.trim()
        || !Array.isArray(question.options) || question.options.length < 2)
      || new Set(questions.map(question => question.question)).size !== questions.length) {
      console.warn(`[PermissionHandler] AskUserQuestion rejected: conversationId=${conversationId}, toolUseId=${options.toolUseID ?? 'unknown'}, reason=invalid-questions`)
      return { behavior: 'deny', message: 'Provide one to four distinct questions, each with at least two options.' }
    }

    const startedAt = Date.now()
    let removeAbortListener: (() => void) | undefined
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
          removeAbortListener = () => options.signal.removeEventListener('abort', onAbort)
        }
      }
    })

    console.log(`[PermissionHandler] AskUserQuestion opened: id=${id}, conversationId=${conversationId}, toolUseId=${options.toolUseID ?? 'unknown'}, questions=${questions.length}`)
    emitAgentEvent('agent:ask-question', spaceId, conversationId, {
      id,
      questions: questions || []
    })

    try {
      // Wait for user answer
      const answers = await answersPromise
      console.log(`[PermissionHandler] AskUserQuestion settled: id=${id}, conversationId=${conversationId}, toolUseId=${options.toolUseID ?? 'unknown'}, status=answered, questions=${questions.length}, answers=${Object.keys(answers).length}, elapsedMs=${Date.now() - startedAt}`)
      return {
        behavior: 'allow' as const,
        updatedInput: { ...input, answers }
      }
    } catch {
      // Question was cancelled or aborted
      console.warn(`[PermissionHandler] AskUserQuestion settled: id=${id}, conversationId=${conversationId}, toolUseId=${options.toolUseID ?? 'unknown'}, status=cancelled, questions=${questions.length}, elapsedMs=${Date.now() - startedAt}`)
      return {
        behavior: 'deny' as const,
        message: 'Question cancelled: the user stopped generation before answering.'
      }
    } finally {
      removeAbortListener?.()
    }
  }
}
