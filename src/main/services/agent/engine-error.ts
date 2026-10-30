/**
 * A turn that could not start because its engine is not on this computer, or
 * because its account signs in through Claude Code and cannot run on the
 * engine chosen. Told by the error's name: both cross module boundaries
 * (and the IM error reply) as plain errors.
 */
export function isEngineSetupError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'EngineUnavailableError') return true
  return error.name === 'EngineSourceCompatibilityError' && (error as { issue?: unknown }).issue === 'delegated-requires-cc'
}

/**
 * What a chat's error event adds when the chat can show the way out (set up
 * Claude Code, change engine or account); nothing for any other failure.
 */
export function engineErrorDetail(error: unknown): { errorType: 'engine_unavailable' } | undefined {
  if (!isEngineSetupError(error)) return undefined
  const engineId = (error as { engineId?: unknown }).engineId
  return error instanceof Error && error.name === 'EngineUnavailableError' && engineId !== 'anthropic'
    ? undefined
    : { errorType: 'engine_unavailable' }
}
