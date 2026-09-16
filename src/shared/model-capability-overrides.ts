import {
  CONTEXT_WINDOW_HARD_CAP,
  MAX_OUTPUT_TOKENS_HARD_CAP
} from './constants/model-runtime-limits'
import type {
  ModelCapability,
  ModelCapabilityOverride
} from './types/model-capabilities'

export const MODEL_CAPABILITY_OVERRIDE_KEYS = [
  'contextWindow',
  'maxOutputTokens',
  'vision',
  'thinking',
  'reasoningEffort',
  'extendedContext'
] as const

const keySet = new Set<string>(MODEL_CAPABILITY_OVERRIDE_KEYS)

type ValidationResult<T> =
  | { valid: true; value: T; ignoredKeys: string[] }
  | { valid: false; error: 'not-object' | 'invalid-value'; ignoredKeys: string[] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isValidInteger(value: unknown, max: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= max
}

export function validateModelCapabilityOverride(
  value: unknown
): ValidationResult<ModelCapabilityOverride> {
  if (!isPlainObject(value)) {
    return { valid: false, error: 'not-object', ignoredKeys: [] }
  }

  const ignoredKeys = Object.keys(value).filter(key => !keySet.has(key))
  const result: ModelCapabilityOverride = {}

  if (value.contextWindow !== undefined) {
    if (!isValidInteger(value.contextWindow, CONTEXT_WINDOW_HARD_CAP)) {
      return { valid: false, error: 'invalid-value', ignoredKeys }
    }
    result.contextWindow = value.contextWindow
  }
  if (value.maxOutputTokens !== undefined) {
    if (!isValidInteger(value.maxOutputTokens, MAX_OUTPUT_TOKENS_HARD_CAP)) {
      return { valid: false, error: 'invalid-value', ignoredKeys }
    }
    result.maxOutputTokens = value.maxOutputTokens
  }
  if (value.vision !== undefined) {
    if (typeof value.vision !== 'boolean') {
      return { valid: false, error: 'invalid-value', ignoredKeys }
    }
    result.vision = value.vision
  }
  if (value.thinking !== undefined) {
    if (typeof value.thinking !== 'boolean') {
      return { valid: false, error: 'invalid-value', ignoredKeys }
    }
    result.thinking = value.thinking
  }
  if (value.reasoningEffort !== undefined) {
    if (
      typeof value.reasoningEffort !== 'string'
      || !value.reasoningEffort.trim()
      || value.reasoningEffort.length > 64
    ) {
      return { valid: false, error: 'invalid-value', ignoredKeys }
    }
    result.reasoningEffort = value.reasoningEffort.trim()
  }
  if (value.extendedContext !== undefined) {
    if (typeof value.extendedContext !== 'boolean') {
      return { valid: false, error: 'invalid-value', ignoredKeys }
    }
    result.extendedContext = value.extendedContext
  }

  return { valid: true, value: result, ignoredKeys }
}

export function validateModelCapabilityOverrides(
  value: unknown
): value is Record<string, ModelCapabilityOverride> {
  if (!isPlainObject(value)) return false
  return Object.entries(value).every(([modelId, override]) =>
    modelId.length > 0
    && modelId.length <= 512
    && validateModelCapabilityOverride(override).valid
  )
}

export function normalizeModelCapabilityOverride(
  override: ModelCapabilityOverride,
  base: ModelCapability
): ModelCapabilityOverride {
  const result: ModelCapabilityOverride = {}
  for (const key of MODEL_CAPABILITY_OVERRIDE_KEYS) {
    const value = override[key]
    if (value === undefined) continue
    if (key === 'extendedContext') {
      if (value === true) result.extendedContext = true
      continue
    }
    if (value !== base[key as keyof ModelCapability]) {
      Object.assign(result, { [key]: value })
    }
  }
  return result
}
