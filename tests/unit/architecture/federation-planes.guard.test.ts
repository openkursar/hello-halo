/**
 * The federation planes have one source (src/shared/federation/planes.json):
 * the Go gateway's plane list and bounds are generated from it, and no TS queue
 * keeps its own copy of the plane bounds.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { readSource } from './lib/source-scan'
// @ts-expect-error — a plain .mjs script, imported for its renderer.
import { renderPlanesGo, PLANES_JSON, PLANES_GO } from '../../../scripts/gen-gateway-planes.mjs'

describe('federation planes come from one source', () => {
  it('gateway/internal/wire/planes_gen.go matches the shared plane list (run node scripts/gen-gateway-planes.mjs)', () => {
    const planes = JSON.parse(readFileSync(PLANES_JSON, 'utf8'))
    expect(readFileSync(PLANES_GO, 'utf8')).toBe(renderPlanesGo(planes))
  })

  it('no federation queue declares its own plane capacities', () => {
    for (const file of ['ws-federation-client.ts', 'gateway-attach.ts']) {
      const source = readSource(`src/main/apps/runtime/federation/${file}`)
      expect(source, file).not.toMatch(/PLANE_QUEUE_CAP|PLANE_DRAIN_ORDER/)
    }
    const goQueue = readSource('gateway/internal/room/queue.go')
    expect(goQueue).toMatch(/wire\.PlaneCapacityFrames/)
    expect(goQueue).not.toMatch(/wire\.PlaneControl:\s*\d+/)
  })
})
