import {
  CONTEXT_WINDOW_HARD_CAP,
  MAX_OUTPUT_TOKENS_HARD_CAP
} from './constants/model-runtime-limits'
import type { ModelOption } from './types/ai-sources'
import type { CatalogModelCapability } from './types/model-capabilities'

function readNested(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function firstValidInteger(max: number, ...values: unknown[]): number | undefined {
  for (const value of values) {
    if (
      typeof value === 'number'
      && Number.isSafeInteger(value)
      && value > 0
      && value <= max
    ) {
      return value
    }
  }
  return undefined
}

/**
 * Only ever reports a positive. `input_modalities` is not an OpenAI-spec
 * field, so a list that omits "image" is just as likely to be an incomplete
 * gateway stub as a real statement of absence — reporting `false` from it
 * would override the id heuristic and silently strip a working model's
 * images. Absence leaves that heuristic in charge.
 */
function inferVisionSupport(modalities: unknown): true | undefined {
  if (!Array.isArray(modalities)) return undefined
  return modalities.some(
    value => typeof value === 'string' && value.toLowerCase() === 'image'
  ) || undefined
}

export function parseCatalogModelCapabilities(raw: unknown): CatalogModelCapability | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>

  const contextWindow = firstValidInteger(
    CONTEXT_WINDOW_HARD_CAP,
    readNested(obj, ['top_provider', 'context_length']),
    obj.context_length,
    obj.context_window,
    obj.contextWindow
  )
  const maxOutputTokens = firstValidInteger(
    MAX_OUTPUT_TOKENS_HARD_CAP,
    readNested(obj, ['top_provider', 'max_completion_tokens']),
    obj.max_completion_tokens,
    obj.max_output_tokens,
    obj.maxOutputTokens
  )

  const result: CatalogModelCapability = {}
  if (contextWindow !== undefined) result.contextWindow = contextWindow
  if (maxOutputTokens !== undefined) result.maxOutputTokens = maxOutputTokens
  return Object.keys(result).length > 0 ? result : undefined
}

export function parseCatalogModelOption(raw: unknown): ModelOption | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.id !== 'string' || !obj.id.trim()) return undefined

  const supportsVision =
    inferVisionSupport(readNested(obj, ['architecture', 'input_modalities']))
    ?? inferVisionSupport(obj.input_modalities)
  const capabilities = parseCatalogModelCapabilities(obj)
  const id = obj.id.trim()

  return {
    id,
    name: typeof obj.name === 'string' && obj.name.trim() ? obj.name : id,
    ...(supportsVision ? { supportsVision } : {}),
    ...(capabilities ? { capabilities } : {})
  }
}

export function isCatalogModelCapability(value: unknown): value is CatalogModelCapability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length === 0 || keys.some(key => key !== 'contextWindow' && key !== 'maxOutputTokens')) {
    return false
  }

  if (
    obj.contextWindow !== undefined
    && firstValidInteger(CONTEXT_WINDOW_HARD_CAP, obj.contextWindow) === undefined
  ) {
    return false
  }
  if (
    obj.maxOutputTokens !== undefined
    && firstValidInteger(MAX_OUTPUT_TOKENS_HARD_CAP, obj.maxOutputTokens) === undefined
  ) {
    return false
  }
  return true
}

export function sanitizeCatalogModelCapability(value: unknown): CatalogModelCapability | undefined {
  return isCatalogModelCapability(value) ? { ...value } : undefined
}
