import { describe, expect, it } from 'vitest'
import type { TeamOutput } from '../../../src/shared/apps/team-types'
import { mergeOutputs, outputGroups } from '../../../src/renderer/components/team/detail/outputs'

const output = (ref: string, at: Date, epochId = 'e1'): TeamOutput =>
  ({ epochId, appId: 'a', memberName: 'writer', ref, name: ref, path: `/work/${ref}`, at: at.getTime() })

describe('team outputs', () => {
  it('buckets newest-first files into today, yesterday, this week, this month, then by month', () => {
    // A Thursday: Monday the 16th starts the week, the 1st starts the month.
    const now = new Date(2026, 10, 19, 15).getTime()
    const groups = outputGroups([
      output('a', new Date(2026, 10, 19, 9)),
      output('b', new Date(2026, 10, 18, 22)),
      output('c', new Date(2026, 10, 16, 1)),
      output('d', new Date(2026, 10, 15, 23)),
      output('e', new Date(2026, 9, 31)),
      output('f', new Date(2026, 9, 2)),
      output('g', new Date(2025, 11, 30)),
    ], now)
    expect(groups.map(group => [group.key, group.outputs.map(item => item.ref).join('')])).toEqual([
      ['today', 'a'], ['yesterday', 'b'], ['week', 'c'], ['month', 'd'], ['2026-9', 'ef'], ['2025-11', 'g'],
    ])
  })

  it('appends a page without repeating a file an earlier page held', () => {
    const at = new Date(2026, 10, 19)
    const merged = mergeOutputs([output('a', at), output('b', at)], [output('b', at), output('b', at, 'e2'), output('c', at)])
    expect(merged.map(item => `${item.epochId}/${item.ref}`)).toEqual(['e1/a', 'e1/b', 'e2/b', 'e1/c'])
  })
})
