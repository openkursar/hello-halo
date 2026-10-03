/**
 * Replication reaches the renderer as row deltas, and replicated/synced batches
 * apply inside one store transaction.
 *
 * - Every feed consumer that applies transcript/board data passes a
 *   `transaction`. The ctrl plane (feed-service, which carries wakes) is the one
 *   justified exception: it persists the cursor per entry so a crash mid-batch
 *   never re-runs a wake that already took effect.
 * - The replica apply path writes through `authorityStore.transaction`.
 * - Replica apply notifications go through `projectReplicaApplied`, which emits
 *   `team:updated` only for structural change (epoch, snapshot, oversized page).
 * - The renderer's board-row handler never reloads run history (a row is merged,
 *   not refetched), and `applyTeamUpdated` reloads only what `changed` lists.
 */

import { describe, it, expect } from 'vitest'
import { findMatches, formatMatches, listSourceFiles, readSource } from './lib/source-scan'

/** Files allowed to build a feed consumer without a transaction, with the reason. */
const NON_TRANSACTIONAL_CONSUMERS: Record<string, string> = {
  'src/main/apps/runtime/federation/log/feed-service.ts':
    'ctrl plane: per-entry cursor persistence keeps a wake at-most-once across a crash',
}

function block(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  return source.slice(start, end < 0 ? undefined : end)
}

describe('federation sync applies in transactions', () => {
  it('every feed consumer outside the ctrl plane passes a transaction', () => {
    const files = listSourceFiles('src/main').filter((f) => readSource(f).includes('createFeedConsumer({'))
    expect(files).toContain('src/main/apps/runtime/federation/session-feed.ts')
    const offenders = files.filter((file) => {
      if (NON_TRANSACTIONAL_CONSUMERS[file]) return false
      const source = readSource(file)
      const call = source.slice(source.indexOf('createFeedConsumer({'))
      const body = call.slice(0, call.indexOf('\n  })') + 1)
      return !/\btransaction:/.test(body)
    })
    expect(offenders, `feed consumers applying without a transaction:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the replica apply path writes through one transaction per pass', () => {
    const source = readSource('src/main/apps/runtime/federation/authority/replication.ts')
    expect(block(source, 'function handleReplicate(', '\n  }\n')).toMatch(/authorityStore\.transaction\(/)
    expect(block(source, 'function applyCatchupPage(', '\n  }\n')).toMatch(/authorityStore\.transaction\(/)
  })
})

describe('replication reaches the renderer as deltas', () => {
  it('replica apply notifications are projected, never mapped straight to team:updated', () => {
    const bootstrap = readSource('src/main/bootstrap/extended.ts')
    const handler = block(bootstrap, 'onReplicaApplied: (officeId, applied) =>', '\n        },\n')
    expect(handler).toMatch(/projectReplicaApplied\(/)
    expect(handler).toMatch(/if \(projection\.refresh\)/)
  })

  it('the renderer merges a board row without reloading run history, and honours the changed hint', () => {
    const store = readSource('src/renderer/stores/team.store.ts')
    const onRow = block(store, 'applyTeamBlackboard: (event) =>', '\n  retainTeamView:')
    expect(onRow).not.toMatch(/loadEpochs\(/)
    const onUpdated = block(store, 'applyTeamUpdated: (event) =>', '\n  applyTeamBlackboard:')
    expect(onUpdated).toMatch(/changed\.includes\('epochs'\)/)
    expect(onUpdated).toMatch(/changed\.includes\('conversations'\)/)
  })

  it('no replication or feed module emits renderer events itself', () => {
    const files = [
      ...listSourceFiles('src/main/apps/runtime/federation/authority'),
      ...listSourceFiles('src/main/apps/runtime/federation/log'),
      'src/main/apps/runtime/federation/session-feed.ts',
      'src/main/apps/runtime/federation/replica-events.ts',
    ]
    const matches = findMatches(files, /\b(sendToRenderer|broadcastToAll)\(/)
    expect(matches, formatMatches(matches)).toEqual([])
  })
})
