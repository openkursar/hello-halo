import { describe, expect, it } from 'vitest'

import {
  EMPTY_MODEL_FIELD,
  canBackfillTestedModel,
  onModelTyped,
  onTestSelected,
  withoutTestSelection
} from '../../../src/renderer/components/setup/model-field'

describe('setup model field', () => {
  it('keeps a value the user typed across endpoint and key changes', () => {
    const typed = onModelTyped('deepseek-chat')
    expect(withoutTestSelection(typed)).toBe(typed)
  })

  it('drops a value the test chose when the endpoint or key changes', () => {
    expect(withoutTestSelection(onTestSelected('gpt-4o'))).toEqual(EMPTY_MODEL_FIELD)
  })

  it('backfills a tested model only on a protocol entry the user has not filled', () => {
    expect(canBackfillTestedModel(false, EMPTY_MODEL_FIELD)).toBe(true)
    expect(canBackfillTestedModel(false, onTestSelected('old-model'))).toBe(true)
    expect(canBackfillTestedModel(false, onModelTyped('typed-model'))).toBe(false)
    expect(canBackfillTestedModel(true, EMPTY_MODEL_FIELD)).toBe(false)
  })
})
