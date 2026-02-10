/**
 * Agent Module - Permission Handler
 *
 * All permissions are controlled via natural language prompts + dangerously-skip-permissions.
 * This handler only exists to respond to CLI permission requests (e.g. ExitPlanMode)
 * with a valid PermissionResult format. It auto-allows everything.
 *
 * Special case: AskUserQuestion tool pauses execution and waits for user answers
 * via IPC, then returns the answers as updatedInput.
 */

// ============================================
// Types
// ============================================

type PermissionResult = {
  behavior: 'allow' | 'deny'
  updatedInput: Record<string, unknown>
}

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal }
) => Promise<PermissionResult>

type SendToRendererFn = (
  channel: string,
  spaceId: string,
  conversationId: string,
  data: Record<string, unknown>
) => void

interface CanUseToolDeps {
  sendToRenderer: SendToRendererFn
  spaceId: string
  conversationId: string
}

// ============================================
// Pending Questions Registry
// ============================================

interface PendingQuestionEntry {
  resolve: (answers: Record<string, string>) => void
  reject: (reason?: unknown) => void
}

/** Map of question ID -> Promise handlers. Module-level for IPC handler access. */
const pendingQuestions = new Map<string, PendingQuestionEntry>()

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
    // Non-AskUserQuestion tools: auto-allow
    if (toolName !== 'AskUserQuestion') {
      return { behavior: 'allow' as const, updatedInput: input }
    }

    // AskUserQuestion: if no deps provided (e.g., warmup), allow with empty answers
    if (!deps) {
      console.warn('[PermissionHandler] AskUserQuestion called without deps, auto-allowing')
      return { behavior: 'allow' as const, updatedInput: { ...input, answers: {} } }
    }

    const { sendToRenderer, spaceId, conversationId } = deps
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const questions = input.questions as Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string }>
      multiSelect: boolean
    }>

    console.log(`[PermissionHandler] AskUserQuestion: id=${id}, questions=${questions?.length || 0}`)

    // Create promise that will be resolved by IPC handler
    const answersPromise = new Promise<Record<string, string>>((resolve, reject) => {
      pendingQuestions.set(id, { resolve, reject })

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

    // Send questions to renderer
    sendToRenderer('agent:ask-question', spaceId, conversationId, {
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
        updatedInput: input
      }
    }
  }
}
