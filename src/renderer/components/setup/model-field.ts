/**
 * The Model ID field's value, and where it came from.
 *
 * A value the test picked is only a suggestion for the endpoint that answered
 * it; changing that endpoint or its credential drops it. A value the user
 * typed is their decision and survives those changes.
 */
export type ModelIdSource = 'user' | 'test'

export interface ModelIdField {
  value: string
  source: ModelIdSource | null
}

export const EMPTY_MODEL_FIELD: ModelIdField = { value: '', source: null }

export function onModelTyped(value: string): ModelIdField {
  return { value, source: 'user' }
}

export function onTestSelected(value: string): ModelIdField {
  return { value, source: 'test' }
}

export function withoutTestSelection(field: ModelIdField): ModelIdField {
  return field.source === 'test' ? EMPTY_MODEL_FIELD : field
}

/**
 * A tested model may backfill only where the field is visible (a protocol
 * entry) and the user has not already named a model themselves.
 */
export function canBackfillTestedModel(hasStaticModels: boolean, field: ModelIdField): boolean {
  return !hasStaticModels && field.source !== 'user'
}
