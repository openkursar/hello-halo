import { describe, it, expect } from 'vitest'
import { applyNewToolsetDefaults, DEFAULT_TOOLSETS } from '../../../src/shared/constants/toolsets'

describe('applyNewToolsetDefaults', () => {
  it('adds a newly default toolset once to an existing saved selection', () => {
    const first = applyNewToolsetDefaults(['ai-terminal'], undefined)
    expect(first.lastToolsets).toEqual(['ai-terminal', 'halo-team'])
    expect(first.seen).toEqual(expect.arrayContaining([...DEFAULT_TOOLSETS]))

    // The user then turns it off; running again must not bring it back.
    const again = applyNewToolsetDefaults(['ai-terminal'], first.seen)
    expect(again.lastToolsets).toEqual(['ai-terminal'])
  })

  it('does not re-add a legacy default the user already turned off', () => {
    expect(applyNewToolsetDefaults([], undefined).lastToolsets).toEqual(['halo-team'])
  })

  it('records the defaults as seen for an install with no saved selection', () => {
    const result = applyNewToolsetDefaults(undefined, undefined)
    expect(result.lastToolsets).toBeUndefined()
    expect(result.seen).toEqual(expect.arrayContaining([...DEFAULT_TOOLSETS]))
  })

  it('does not duplicate an id that is already selected', () => {
    expect(applyNewToolsetDefaults(['halo-team'], undefined).lastToolsets).toEqual(['halo-team'])
  })
})
