/**
 * Where a card from the page goes: the composer of the conversation beside
 * the canvas, named by the page's reference layer and by nothing else.
 */

import { describe, expect, it } from 'vitest'
import { findMatches, formatMatches, listSourceFiles, readSource } from './lib/source-scan'

const LAYER = 'src/renderer/components/references/ReferenceLayer.tsx'

describe('composer references', () => {
  it('are pointed at a composer only by the page reference layer', () => {
    // Any other composer naming itself the target — a team chat opened in the
    // canvas, say — would take the cards and the numbered highlights meant for
    // the conversation beside the canvas.
    const users = listSourceFiles('src/renderer').filter((file) => readSource(file).includes('composer-references.store'))
    const offenders = findMatches(users, /\bsetTarget\(/).filter((match) => match.file.replace(/\\/g, '/') !== LAYER)
    expect(offenders, formatMatches(offenders)).toEqual([])
  })
})
