#!/usr/bin/env node
/**
 * analyze-heap — diffs two V8 heap snapshots and, for the classes that grew,
 * walks back to a retaining root.
 *
 *   node tests/perf/analyze-heap.mjs <before.heapsnapshot> <after.heapsnapshot> [--retain=<ClassName>]
 *
 * The class diff answers "what accumulated"; `--retain` answers the question
 * that actually assigns blame, "and who is still holding it", by walking the
 * reverse edge index from one surviving instance up to a GC root. A count on
 * its own names a symptom — a growing class is equally consistent with a cache
 * that will be trimmed and with a leak.
 */

import fs from 'fs'

const [beforePath, afterPath, ...rest] = process.argv.slice(2)
if (!beforePath || !afterPath) {
  console.error('usage: analyze-heap.mjs <before.heapsnapshot> <after.heapsnapshot> [--retain=<ClassName>]')
  process.exit(2)
}
const retainArg = rest.find((a) => a.startsWith('--retain='))?.slice('--retain='.length)

function load(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const meta = raw.snapshot.meta
  const nodeFields = meta.node_fields
  const nodeTypes = meta.node_types[0]
  const edgeFields = meta.edge_fields
  const edgeTypes = meta.edge_types[0]
  const nodeFieldCount = nodeFields.length
  const edgeFieldCount = edgeFields.length

  const idx = (fields, name) => fields.indexOf(name)
  const shape = {
    type: idx(nodeFields, 'type'),
    name: idx(nodeFields, 'name'),
    id: idx(nodeFields, 'id'),
    selfSize: idx(nodeFields, 'self_size'),
    edgeCount: idx(nodeFields, 'edge_count'),
    detachedness: idx(nodeFields, 'detachedness')
  }
  const edgeShape = {
    type: idx(edgeFields, 'type'),
    nameOrIndex: idx(edgeFields, 'name_or_index'),
    toNode: idx(edgeFields, 'to_node')
  }

  const nodeCount = raw.nodes.length / nodeFieldCount
  // Edges are stored flat and in node order, so a node's edges start where the
  // preceding nodes' edge counts end. Without this offset table the graph
  // cannot be walked at all.
  const firstEdge = new Uint32Array(nodeCount + 1)
  let running = 0
  for (let i = 0; i < nodeCount; i++) {
    firstEdge[i] = running
    running += raw.nodes[i * nodeFieldCount + shape.edgeCount]
  }
  firstEdge[nodeCount] = running

  return {
    raw,
    strings: raw.strings,
    nodes: raw.nodes,
    edges: raw.edges,
    nodeFieldCount,
    edgeFieldCount,
    nodeTypes,
    edgeTypes,
    shape,
    edgeShape,
    nodeCount,
    firstEdge,
    nodeName: (i) => raw.strings[raw.nodes[i * nodeFieldCount + shape.name]],
    nodeType: (i) => nodeTypes[raw.nodes[i * nodeFieldCount + shape.type]],
    nodeSelfSize: (i) => raw.nodes[i * nodeFieldCount + shape.selfSize],
    nodeId: (i) => raw.nodes[i * nodeFieldCount + shape.id],
    // 0 unknown, 1 attached, 2 detached — only meaningful for DOM wrappers.
    nodeDetached: (i) => (shape.detachedness >= 0 ? raw.nodes[i * nodeFieldCount + shape.detachedness] : 0)
  }
}

/** Counts and total self size per `type:name`, plus the detached-only tally. */
function census(snap) {
  const all = new Map()
  const detached = new Map()
  for (let i = 0; i < snap.nodeCount; i++) {
    const key = `${snap.nodeType(i)}:${snap.nodeName(i)}`
    const entry = all.get(key) || { count: 0, bytes: 0 }
    entry.count++
    entry.bytes += snap.nodeSelfSize(i)
    all.set(key, entry)
    if (snap.nodeDetached(i) === 2) {
      const d = detached.get(snap.nodeName(i)) || { count: 0, bytes: 0 }
      d.count++
      d.bytes += snap.nodeSelfSize(i)
      detached.set(snap.nodeName(i), d)
    }
  }
  return { all, detached }
}

function diff(before, after, minDelta = 5) {
  const keys = new Set([...before.keys(), ...after.keys()])
  const rows = []
  for (const key of keys) {
    const b = before.get(key) || { count: 0, bytes: 0 }
    const a = after.get(key) || { count: 0, bytes: 0 }
    const delta = a.count - b.count
    if (delta >= minDelta) rows.push({ key, before: b.count, after: a.count, delta, bytesDelta: a.bytes - b.bytes })
  }
  return rows.sort((x, y) => y.delta - x.delta)
}

/** Reverse index: for each node, which nodes point at it and under what edge name. */
function buildRetainers(snap) {
  const { edges, edgeFieldCount, edgeShape, nodeFieldCount, firstEdge, nodeCount } = snap
  const retainers = new Map()
  for (let from = 0; from < nodeCount; from++) {
    const start = firstEdge[from]
    const end = firstEdge[from + 1]
    for (let e = start; e < end; e++) {
      const base = e * edgeFieldCount
      const to = edges[base + edgeShape.toNode] / nodeFieldCount
      const type = snap.edgeTypes[edges[base + edgeShape.type]]
      // Index-typed edges name their slot with a number, not a string.
      const nameRaw = edges[base + edgeShape.nameOrIndex]
      const name = type === 'element' || type === 'hidden' ? String(nameRaw) : snap.strings[nameRaw]
      let list = retainers.get(to)
      if (!list) { list = []; retainers.set(to, list) }
      if (list.length < 12) list.push({ from, type, name })
    }
  }
  return retainers
}

/**
 * Shortest path from an instance back to a root, breadth-first so the reported
 * chain is the closest thing to "why this is still alive" rather than an
 * arbitrarily long one. Weak edges are skipped: they do not keep anything alive
 * and following them would name an innocent retainer.
 */
function retainerPath(snap, retainers, startNode, maxDepth = 14) {
  const seen = new Set([startNode])
  let frontier = [{ node: startNode, path: [] }]
  for (let depth = 0; depth < maxDepth; depth++) {
    const next = []
    for (const { node, path } of frontier) {
      for (const r of retainers.get(node) || []) {
        if (seen.has(r.from)) continue
        seen.add(r.from)
        const name = snap.nodeName(r.from)
        const type = snap.nodeType(r.from)
        const step = `${type}:${name} --${r.type}:${r.name}-->`
        if (r.type === 'weak') continue
        if (type === 'synthetic' || name === 'GC roots' || name === 'Window') {
          return [...path, step].reverse()
        }
        next.push({ node: r.from, path: [...path, step] })
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  return frontier[0] ? frontier[0].path.reverse() : []
}

console.log(`before: ${beforePath}`)
console.log(`after:  ${afterPath}\n`)

const before = load(beforePath)
const after = load(afterPath)
const censusBefore = census(before)
const censusAfter = census(after)

console.log(`nodes: ${before.nodeCount} -> ${after.nodeCount} (+${after.nodeCount - before.nodeCount})\n`)

console.log('=== classes that grew (count) ===')
for (const row of diff(censusBefore.all, censusAfter.all).slice(0, 30)) {
  console.log(`  +${String(row.delta).padStart(5)}  ${row.before} -> ${row.after}  ${(row.bytesDelta / 1024).toFixed(0).padStart(7)} KB  ${row.key}`)
}

console.log('\n=== detached DOM wrappers that grew ===')
const detachedRows = diff(censusBefore.detached, censusAfter.detached, 1)
if (detachedRows.length === 0) console.log('  (none)')
for (const row of detachedRows.slice(0, 25)) {
  console.log(`  +${String(row.delta).padStart(5)}  ${row.before} -> ${row.after}  ${row.key}`)
}

if (retainArg) {
  console.log(`\n=== retainer paths for "${retainArg}" (in the after snapshot) ===`)
  const retainers = buildRetainers(after)
  const instances = []
  for (let i = 0; i < after.nodeCount; i++) {
    if (after.nodeName(i) === retainArg) instances.push(i)
  }
  // A detached instance is the one worth explaining: an attached one is held by
  // the document, which answers nothing.
  const detachedInstances = instances.filter((i) => after.nodeDetached(i) === 2)
  const chosen = detachedInstances.length > 0 ? detachedInstances : instances
  console.log(`  ${instances.length} instance(s) named "${retainArg}"${detachedInstances.length ? `, ${detachedInstances.length} detached — reporting those` : ''}`)
  for (const node of chosen.slice(-3)) {
    console.log(`\n  --- instance id ${after.nodeId(node)} ---`)
    const chain = retainerPath(after, retainers, node)
    if (chain.length === 0) console.log('    (no path found within depth limit)')
    for (const step of chain) console.log(`    ${step}`)
  }
}
