/**
 * Agent Module - Permission Handler
 *
 * All permissions are controlled via natural language prompts + dangerously-skip-permissions.
 * This handler only exists to respond to CLI permission requests (e.g. ExitPlanMode)
 * with a valid PermissionResult format. It auto-allows everything.
 */

// ============================================
// Permission Handler Factory
// ============================================

type PermissionResult = {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
}

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal }
) => Promise<PermissionResult>

/**
 * Create tool permission handler that auto-allows all tools.
 *
 * Most tools are handled by CLI internally (via dangerously-skip-permissions).
 * This callback is only invoked for special tools like ExitPlanMode/EnterPlanMode
 * that the CLI cannot decide on its own.
 */
export function createCanUseTool(): CanUseToolFn {
  return async (
    _toolName: string,
    input: Record<string, unknown>
  ): Promise<PermissionResult> => {
    return { behavior: 'allow' as const, updatedInput: input }
  }
}
