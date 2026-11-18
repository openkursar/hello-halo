import { needsAttention, talkClusters, type CrewEntry, type CrewLink } from './crew'

/** Every face on the scene is one size; the lead is told apart by its bold name. */
export const SCENE_RADIUS = 18
export const LABEL_LINE = 14

export interface SceneFace { appId: string; x: number; y: number; talking: boolean }
export interface SceneLabel { key: string; appIds: string[]; x: number; y: number; width: number; lines: number; single: boolean }
export interface SceneLayout {
  faces: SceneFace[]
  labels: SceneLabel[]
  more: { x: number; y: number; count: number } | null
  width: number
  height: number
}

interface Item {
  width: number
  up: number
  down: number
  place: (x: number, y: number, out: SceneLayout) => void
}

const GAP = 24
const ROW_GAP = 14
const MORE_RADIUS = 17

/**
 * Members on the task laid out across the stage: each talking cluster overlaps in
 * a ring (pair, triangle, square, then a circle), everyone else stands alone, and
 * rows wrap at the stage width. Coordinates start at the content's top.
 */
export function layoutScene(shown: readonly CrewEntry[], hidden: number, links: readonly CrewLink[], leadAppId: string | null, stageWidth: number): SceneLayout {
  const state = new Map(shown.map(entry => [entry.appId, entry.state]))
  const rank = (group: string[]) => group.some(appId => needsAttention(state.get(appId)!)) ? 0 : group.includes(leadAppId ?? '') ? 1 : group.length > 1 ? 2 : 3
  const groups = talkClusters(shown.map(entry => entry.appId), links).sort((a, b) => rank(a) - rank(b))
  // Working and done need no words: the dot and the check already say it.
  const quiet = (appId: string) => state.get(appId) === 'working' || state.get(appId) === 'done'
  const items: Item[] = groups.map(group => group.length > 1 ? cluster(group, leadAppId) : single(group[0], !quiet(group[0])))
  if (hidden) items.push({
    width: 48, up: 22, down: 22,
    place: (x, y, out) => { out.more = { x, y, count: hidden } },
  })

  const rows: Item[][] = [[]]
  let used = 0
  for (const item of items) {
    const row = rows[rows.length - 1]
    if (row.length && used + GAP + item.width > stageWidth - 10) {
      rows.push([item])
      used = item.width
    } else {
      used += (row.length ? GAP : 0) + item.width
      row.push(item)
    }
  }

  // A finished team stands in a line; while working, a slight stagger keeps it from reading as a table.
  const stagger = shown.some(entry => entry.state !== 'done')
  const out: SceneLayout = { faces: [], labels: [], more: null, width: stageWidth, height: 0 }
  let y = 0
  let top = Infinity
  let bottom = 0
  let index = 0
  for (const row of rows) {
    if (!row.length) continue
    const up = Math.max(...row.map(item => item.up))
    const down = Math.max(...row.map(item => item.down))
    y += up
    const total = row.reduce((sum, item) => sum + item.width, 0) + GAP * (row.length - 1)
    let left = stageWidth / 2 - total / 2
    for (const item of row) {
      const dy = stagger && row.length > 1 ? (index++ % 2 ? 6 : -4) : 0
      top = Math.min(top, y + dy - item.up)
      bottom = Math.max(bottom, y + dy + item.down)
      item.place(left + item.width / 2, y + dy, out)
      left += item.width + GAP
    }
    y += down + ROW_GAP
  }
  if (top === Infinity) return out
  for (const face of out.faces) face.y -= top
  for (const label of out.labels) label.y -= top
  if (out.more) out.more.y -= top
  out.height = bottom - top
  return out
}

function single(appId: string, withState: boolean): Item {
  const r = SCENE_RADIUS
  const lines = withState ? 2 : 1
  return {
    width: 64, up: r + 6, down: r + 4 + lines * LABEL_LINE,
    place: (x, y, out) => {
      out.faces.push({ appId, x, y, talking: false })
      out.labels.push({ key: appId, appIds: [appId], x, y: y + r + 4, width: 72, lines, single: true })
    },
  }
}

function cluster(group: string[], leadAppId: string | null): Item {
  const n = group.length
  const r = SCENE_RADIUS
  const side = r * 2 - 4
  const radius = n === 2 ? side / 2 : side / (2 * Math.sin(Math.PI / n))
  const start = n === 2 ? Math.PI : n === 4 ? -Math.PI * 3 / 4 : -Math.PI / 2
  const points = group.map((appId, i) => {
    const angle = start + i * 2 * Math.PI / n
    return { appId, dx: radius * Math.cos(angle), dy: radius * Math.sin(angle) }
  })
  const reach = radius + r + 5
  const lowest = Math.max(...points.map(point => point.dy)) + r
  const lines = n <= 2 ? 1 : 2
  const width = Math.max(reach * 2, n <= 2 ? 120 : 140)
  return {
    width, up: Math.max(reach, -Math.min(...points.map(point => point.dy)) + r) + 4, down: lowest + 6 + lines * LABEL_LINE,
    place: (x, y, out) => {
      // The lead is placed last so it sits on top where faces overlap.
      for (const point of [...points].sort((a, b) => Number(a.appId === leadAppId) - Number(b.appId === leadAppId))) {
        out.faces.push({ appId: point.appId, x: x + point.dx, y: y + point.dy, talking: true })
      }
      out.labels.push({ key: [...group].sort().join('\n'), appIds: group, x, y: y + lowest + 6, width, lines, single: false })
    },
  }
}

export { MORE_RADIUS }
