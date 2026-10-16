import { describe, it, expect } from 'vitest'
import { layoutGraph } from '../../../src/renderer/components/canvas/viewers/changes/graph/lanes'

const c = (oid: string, ...parents: string[]) => ({ oid, parents })

describe('commit graph lanes', () => {
  it('keeps a linear history in one lane', () => {
    const { rows, laneCount } = layoutGraph([c('c2', 'c1'), c('c1', 'c0'), c('c0')])
    expect(laneCount).toBe(1)
    expect(rows).toEqual([
      { lane: 0, incoming: [], outgoing: [0], through: [] },
      { lane: 0, incoming: [0], outgoing: [0], through: [] },
      { lane: 0, incoming: [0], outgoing: [], through: [] },
    ])
  })

  it('gives a merge a second lane that converges on the merged commit', () => {
    const { rows, laneCount } = layoutGraph([
      c('m', 'b', 'a'),
      c('b', 'root'),
      c('a', 'root'),
      c('root'),
    ])
    expect(laneCount).toBe(2)
    expect(rows[0]).toEqual({ lane: 0, incoming: [], outgoing: [0, 1], through: [] })
    // The lane of the side branch crosses the rows above its commit.
    expect(rows[1]).toEqual({ lane: 0, incoming: [0], outgoing: [0], through: [1] })
    expect(rows[2]).toEqual({ lane: 1, incoming: [1], outgoing: [1], through: [0] })
    // Both lanes end at the root, which frees them.
    expect(rows[3]).toEqual({ lane: 0, incoming: [0, 1], outgoing: [], through: [] })
  })

  it('reuses a lane freed where two edges converged', () => {
    // a receives the main lane and the side lane; its second parent then takes
    // the freed side lane instead of opening a third one.
    const { rows, laneCount } = layoutGraph([
      c('x', 'm', 'a'),
      c('m', 'b', 'a'),
      c('b', 'a'),
      c('a', 'r', 's'),
      c('s'),
      c('r'),
    ])
    expect(laneCount).toBe(2)
    expect(rows[3]).toEqual({ lane: 0, incoming: [0, 1], outgoing: [0, 1], through: [] })
    expect(rows[4]).toEqual({ lane: 1, incoming: [1], outgoing: [], through: [0] })
  })

  it('keeps a parent outside the loaded window on its lane', () => {
    const { rows, laneCount } = layoutGraph([c('c1', 'c0'), c('c0', 'older')])
    expect(laneCount).toBe(1)
    expect(rows[1].outgoing).toEqual([0])
  })

  it('connects a filtered list only between loaded commits', () => {
    // 'dropped' never loads (the filter removed it): an edge to it would hold a
    // lane forever, widening the graph per row. Loaded parent-child chains connect.
    const commits = [c('c3', 'c2'), c('c2', 'c1'), c('c1', 'dropped')]
    const { rows, laneCount } = layoutGraph(commits, undefined, { parents: 'loaded' })
    expect(laneCount).toBe(1)
    expect(rows[0].outgoing).toEqual([0])
    expect(rows[1].outgoing).toEqual([0])
    expect(rows[2].outgoing).toEqual([])
  })

  it('runs a sibling branch in its own lane until the shared parent', () => {
    const { rows, laneCount } = layoutGraph([c('a', 'root'), c('b', 'root'), c('root')])
    expect(laneCount).toBe(2)
    expect(rows[0]).toEqual({ lane: 0, incoming: [], outgoing: [0], through: [] })
    expect(rows[1]).toEqual({ lane: 1, incoming: [], outgoing: [1], through: [0] })
    expect(rows[2]).toEqual({ lane: 0, incoming: [0, 1], outgoing: [], through: [] })
  })
})
