import { describe, expect, it } from 'vitest'

import { createRequestGate } from '../../../src/renderer/utils/request-gate'

describe('createRequestGate', () => {
  it('keeps only the latest started request current', () => {
    const gate = createRequestGate()
    const first = gate.begin()
    expect(gate.isCurrent(first)).toBe(true)

    const second = gate.begin()
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
  })

  it('drops a result after the inputs it depended on change', () => {
    const gate = createRequestGate()
    const token = gate.begin()
    gate.invalidate()
    expect(gate.isCurrent(token)).toBe(false)
  })
})
