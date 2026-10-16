/**
 * Lane assignment for the commit graph: which column each commit sits in and
 * which lanes enter, cross and leave every row, so a row can draw its piece of
 * the graph without knowing the others. Pure; extended page by page as rows
 * load, never recomputed from the start (a deep scroll never blocks a frame).
 *
 * Commits arrive in `--topo-order` (children before parents). A lane carries
 * the oid of the commit it is heading to; a row claims every lane whose oid it
 * is, reuses the first as its own column, puts its first parent's edge there
 * and gives further parents a free (or converging) lane. A parent outside the
 * loaded window keeps its lane, drawn to the last loaded row.
 *
 * A filtered list (author or message) breaks that last rule: parents that the
 * filter drops never load, so their lanes would never free and lane count would
 * grow with every row. There, edges are drawn only between commits both in the
 * loaded list (`parents: 'loaded'`); a parent still outside it — dropped by the
 * filter, or merely in a later page — leaves its child as a detached node.
 */

export interface GraphSourceCommit {
  oid: string
  parents: string[]
}

export interface GraphRowLayout {
  /** The commit's own column. */
  lane: number
  /** Lanes entering from the row above that curve into the commit's node. */
  incoming: number[]
  /** Lanes the parent edges occupy leaving the row's bottom. Empty at a root. */
  outgoing: number[]
  /** Lanes crossing the row untouched. */
  through: number[]
}

/** The fold's state between rows; carried from one page to the next. */
export interface LaneState {
  /** Lane → the oid the lane is heading to; null is a free slot. */
  expected: (string | null)[]
  /** Highest lane index used so far. */
  maxLane: number
}

export interface GraphLayout {
  rows: GraphRowLayout[]
  /** Columns the whole graph spans; rows address lanes `0..laneCount - 1`. */
  laneCount: number
  /** State after the last row: pass it back to extend with later pages. */
  state: LaneState
}

export function layoutGraph(
  commits: readonly GraphSourceCommit[],
  /** The result of laying out that many of the same commits, to extend from. */
  previous?: { count: number; state: LaneState; rows: GraphRowLayout[] },
  /** `parents: 'loaded'` on a filtered list: edges only between loaded commits. */
  options: { parents?: 'all' | 'loaded' } = {},
): GraphLayout {
  const expected = previous ? previous.state.expected.slice() : []
  let maxLane = previous?.state.maxLane ?? -1
  const rows = previous ? previous.rows.slice() : []
  const loaded = options.parents === 'loaded' ? new Set(commits.map((c) => c.oid)) : null

  for (let i = previous?.count ?? 0; i < commits.length; i++) {
    const commit = commits[i]
    const incoming: number[] = []
    const occupied: number[] = []
    expected.forEach((target, index) => {
      if (target === null) return
      occupied.push(index)
      if (target === commit.oid) incoming.push(index)
    })

    const freeLane = (): number => {
      const free = expected.indexOf(null)
      if (free !== -1) return free
      expected.push(null)
      return expected.length - 1
    }
    const lane = incoming.length > 0 ? incoming[0] : freeLane()
    incoming.slice(1).forEach((index) => { expected[index] = null })

    const outgoing: number[] = []
    const parents = loaded ? commit.parents.filter((oid) => loaded.has(oid)) : commit.parents
    if (parents.length > 0) {
      expected[lane] = parents[0]
      outgoing.push(lane)
      for (const parent of parents.slice(1)) {
        let heading = expected.indexOf(parent)
        if (heading === -1) {
          heading = freeLane()
          expected[heading] = parent
        }
        outgoing.push(heading)
      }
    } else {
      expected[lane] = null
    }

    maxLane = Math.max(maxLane, lane, ...incoming, ...outgoing)
    const through = occupied.filter((index) => !incoming.includes(index))
    rows.push({ lane, incoming, outgoing, through })
  }

  return { rows, laneCount: maxLane + 1, state: { expected, maxLane } }
}
