import type { EngineId } from './types/engine'

export interface EngineSourceDescriptor {
  provider?: string
  oauthProvider?: string
  authType?: string
  apiType?: string
  delegatedAuth?: boolean
  /** A load-balancing group, which the router serves on the Anthropic Messages wire only. */
  isGroup?: boolean
}

export type EngineSourceIssueCode = 'delegated-requires-cc' | 'codex-unsupported-protocol' | 'codex-unsupported-group'
export type EngineSourceCompatibility = { compatible: true } | { compatible: false; code: EngineSourceIssueCode; message: string }

/** Account protocol, never a model-name heuristic, decides whether an engine may send a request. */
export function getEngineSourceCompatibility(engineId: EngineId, source?: EngineSourceDescriptor | null): EngineSourceCompatibility {
  if (!source) return { compatible: true }
  if ((source.delegatedAuth || source.authType === 'delegated') && engineId !== 'anthropic') {
    return { compatible: false, code: 'delegated-requires-cc', message: 'This account requires Claude Code. Choose Claude Code or another model account.' }
  }
  if (engineId === 'codex' && source.isGroup) {
    return { compatible: false, code: 'codex-unsupported-group', message: 'Codex cannot use a load-balancing group. Choose a single model account or another engine.' }
  }
  if (engineId === 'codex' && (
    source.provider === 'anthropic' || source.provider === 'claude' || source.oauthProvider === 'claude'
    || (source.apiType !== undefined && source.apiType !== 'chat_completions' && source.apiType !== 'responses')
  )) {
    return { compatible: false, code: 'codex-unsupported-protocol', message: 'Codex supports OpenAI-compatible Chat Completions and Responses accounts. Choose another account or another engine.' }
  }
  return { compatible: true }
}

/**
 * What an engine checks about the target a stored model selection resolves to:
 * its account, or — for a load-balancing group, which has none of its own — the
 * group itself.
 */
export function engineSourceOf(selected: { source: EngineSourceDescriptor | null; group?: unknown }): EngineSourceDescriptor | null {
  return selected.group ? { isGroup: true } : selected.source
}

export class EngineSourceCompatibilityError extends Error {
  readonly code = 'ENGINE_SOURCE_INCOMPATIBLE'
  constructor(readonly engineId: EngineId, readonly issue: EngineSourceIssueCode, message: string) {
    super(message)
    this.name = 'EngineSourceCompatibilityError'
  }
}

export function assertEngineSourceCompatible(engineId: EngineId, source: EngineSourceDescriptor): void {
  const result = getEngineSourceCompatibility(engineId, source)
  if (!result.compatible) throw new EngineSourceCompatibilityError(engineId, result.code, result.message)
}
