/**
 * Joiner catch-up cost, measured on the real replication and session-feed code
 * over real SQLite (no mocks of the logic under test).
 *
 *   node_modules/.bin/esbuild tests/perf/checks/federation-joiner-catchup.ts --bundle \
 *     --platform=node --format=cjs --external:better-sqlite3 --external:electron \
 *     --outfile=/tmp/federation-joiner-catchup.cjs
 *   NODE_PATH=$PWD/node_modules ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron /tmp/federation-joiner-catchup.cjs
 *
 * Board: a joiner behind an authority log of LOG_ENTRIES entries pages itself to
 * the head. Gated on structure — pages, applied notifications, renderer events,
 * the IPC refetches those events cost — which reproduce across machine load;
 * durations are printed for same-machine comparison only.
 *
 * Transcripts: one joiner applies AUTHORS × ENTRIES session-feed entries served
 * by the authority's mirror. Gated on rows written per entry and transactions
 * per batch.
 *
 * Exit code 1 when a precondition or a structural bound fails.
 */

import { performance } from 'node:perf_hooks'
import { createDatabaseManager } from '../../../src/main/platform/store/database-manager'
import { AuthorityStore } from '../../../src/main/apps/federation/authority-store'
import { FeedStore } from '../../../src/main/apps/federation/feed-store'
import { MIGRATION_NAMESPACE as FED_NS, migrations as fedMigrations } from '../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE as TEAM_NS, migrations as teamMigrations } from '../../../src/main/apps/team/migrations'
import { createReplication, REPLICATION_CATCHUP_BATCH } from '../../../src/main/apps/runtime/federation/authority/replication'
import { projectReplicaApplied } from '../../../src/main/apps/runtime/federation/replica-events'
import { createSessionFeed } from '../../../src/main/apps/runtime/federation/session-feed'
import { feedIdKey, type FeedEntry, type FeedSyncFrame } from '../../../src/main/apps/runtime/federation/log/types'
import { buildTeamSessionKey } from '../../../src/shared/apps/im-keys'

const OFFICE = 'office-perf'
const LOG_ENTRIES = 20_000
const AUTHORS = 20
const ENTRIES = 200
/** Renderer reloads one refresh event costs (detail, epochs, conversations). */
const IPC_PER_REFRESH = 3

const failures: string[] = []
function check(ok: boolean, what: string): void {
  if (!ok) failures.push(what)
}

function stores() {
  const dbm = createDatabaseManager(':memory:')
  const db = dbm.getAppDatabase()
  dbm.runMigrations(db, FED_NS, fedMigrations)
  dbm.runMigrations(db, TEAM_NS, teamMigrations)
  return { dbm, authority: new AuthorityStore(db), team: new TeamStore(db), feed: new FeedStore(db) }
}

function boardCatchup(): void {
  const auth = stores()
  const route = { toJoiner: (_f: unknown) => {} }
  const authority = createReplication({
    officeId: OFFICE, selfNodeId: 'authority', authorityStore: auth.authority, replicaStore: auth.team,
    send: (_to, frame) => route.toJoiner(frame), broadcast: () => {},
    getTerm: () => 1, getCommittedSeq: () => 0, setCommittedSeq: () => {},
    getOnlineStandbys: () => [], getHeir: () => null, getKnownStandbyCount: () => 0,
    getAuthorityNodeId: () => 'authority',
  })
  auth.authority.transaction(() => {
    for (let i = 1; i <= LOG_ENTRIES; i++) {
      authority.captureLocalWrite({
        teamId: OFFICE, epochId: 'e1', op: 'post_activity',
        payload: { id: `a${i}`, teamId: OFFICE, epochId: 'e1', kind: 'message', actorAppId: 'x', targetAppId: null, subject: 's'.repeat(200), body: null, refId: null, correlationId: null, status: null, createdAt: i },
      })
    }
  })

  const joiner = stores()
  let notifications = 0
  let boardEvents = 0
  let refreshes = 0
  let requests = 0
  const standby = createReplication({
    officeId: OFFICE, selfNodeId: 'joiner', authorityStore: joiner.authority, replicaStore: joiner.team,
    send: (_to, frame) => {
      if (frame.kind === 'catchup-request') {
        requests++
        authority.handleM2Frame('joiner', frame)
      }
    },
    broadcast: () => {},
    getTerm: () => 1, getCommittedSeq: () => 0, setCommittedSeq: () => {},
    getOnlineStandbys: () => [], getHeir: () => null, getKnownStandbyCount: () => 0,
    getAuthorityNodeId: () => 'authority',
    onReplicaApplied: (applied) => {
      notifications++
      const projection = projectReplicaApplied(OFFICE, applied, (id) => joiner.team.getTaskById(id))
      boardEvents += projection.boardEvents.length
      if (projection.refresh) refreshes++
    },
  })
  route.toJoiner = (frame) => standby.handleM2Frame('authority', frame as never)

  const t0 = performance.now()
  standby.requestCatchupFrom('authority')
  const ms = performance.now() - t0

  const applied = standby.getAppliedSeq()
  check(applied === LOG_ENTRIES, `board: joiner reached ${applied} of ${LOG_ENTRIES}`)
  const pages = Math.ceil(LOG_ENTRIES / REPLICATION_CATCHUP_BATCH)
  check(requests <= pages + 1, `board: ${requests} catch-up requests > ${pages + 1}`)
  check(refreshes + boardEvents <= 80, `board: ${refreshes + boardEvents} renderer events > 80`)
  check(refreshes * IPC_PER_REFRESH <= 240, `board: ${refreshes * IPC_PER_REFRESH} refetch IPCs > 240`)
  console.log(
    `[board] ${LOG_ENTRIES} entries: requests=${requests} notifications=${notifications} ` +
      `renderer events=${refreshes + boardEvents} (refresh=${refreshes}, delta=${boardEvents}) ` +
      `refetch IPC ≤ ${refreshes * IPC_PER_REFRESH} (per-row model before: ${LOG_ENTRIES} events / ${LOG_ENTRIES * IPC_PER_REFRESH} IPC) ` +
      `in ${ms.toFixed(0)} ms`
  )
  auth.dbm.closeAll()
  joiner.dbm.closeAll()
}

function transcriptReplication(): void {
  const owner = stores()
  const joiner = stores()
  const joinerRows = { putCache: 0, transactions: 0 }
  const putCache = joiner.feed.putCache.bind(joiner.feed)
  joiner.feed.putCache = (...args) => {
    joinerRows.putCache++
    putCache(...args)
  }
  const tx = joiner.feed.transaction.bind(joiner.feed)
  joiner.feed.transaction = (fn) => {
    joinerRows.transactions++
    return tx(fn)
  }
  const frames: FeedSyncFrame[] = []
  const joinerFeed = createSessionFeed({
    officeId: OFFICE, selfNodeId: 'joiner', feedStore: joiner.feed,
    sendToPeer: () => {}, broadcast: () => {},
    readOwnedTranscript: () => null, isSessionActive: () => false,
    servesMirror: () => false, acceptEntriesFrom: () => true, retransmitIntervalMs: 0,
  })
  let total = 0
  for (let a = 0; a < AUTHORS; a++) {
    const sessionKey = buildTeamSessionKey(`app-${a}`, OFFICE, 'e1')
    const feedKey = feedIdKey({ officeId: OFFICE, author: `node-${a}`, kind: `session:${sessionKey}` })
    for (let i = 0; i < ENTRIES; i += 16) {
      const entries: FeedEntry[] = []
      for (let s = i + 1; s <= Math.min(i + 16, ENTRIES); s++) {
        entries.push({ seq: s, hlc: s.toString(16).padStart(16, '0'), fid: `f-${a}-${s}`, type: 'msg', payload: { seq: s, role: 'assistant', content: 'x'.repeat(1200) }, ts: s })
      }
      frames.push({ kind: 'feed-entries', officeId: OFFICE, feedKey, entries, upToSeq: ENTRIES, more: i + 16 < ENTRIES, truncatedBeforeSeq: 0 })
      total += entries.length
    }
  }
  const t0 = performance.now()
  for (const frame of frames) joinerFeed.handleFrame('authority', frame)
  const ms = performance.now() - t0
  const rowsPerEntry = joinerRows.putCache / total
  check(total === AUTHORS * ENTRIES, 'transcripts: fixture incomplete')
  check(rowsPerEntry === 1, `transcripts: ${rowsPerEntry} cache rows per entry on a joiner (want 1)`)
  check(joinerRows.transactions === frames.length, `transcripts: ${joinerRows.transactions} transactions for ${frames.length} batches`)
  console.log(
    `[transcripts] ${total} entries in ${frames.length} batches: cache rows/entry=${rowsPerEntry} (before: 2) ` +
      `transactions=${joinerRows.transactions} in ${ms.toFixed(0)} ms`
  )
  joinerFeed.stop()
  owner.dbm.closeAll()
  joiner.dbm.closeAll()
}

/** Lazy replication: a joiner that shows one member's panel applies only that member's transcript. */
function lazyReplication(): void {
  const joiner = stores()
  let applied = 0
  const watched = feedIdKey({ officeId: OFFICE, author: 'node-0', kind: `session:${buildTeamSessionKey('app-0', OFFICE, 'e1')}` })
  const feed = createSessionFeed({
    officeId: OFFICE, selfNodeId: 'joiner', feedStore: joiner.feed,
    sendToPeer: () => {}, broadcast: () => {},
    readOwnedTranscript: () => null, isSessionActive: () => false,
    servesMirror: () => false, acceptEntriesFrom: () => true, retransmitIntervalMs: 0,
    wantsReplica: (key) => key === watched,
    onApplied: () => { applied++ },
  })
  const digest: Array<[string, number]> = []
  const frames: FeedSyncFrame[] = []
  for (let a = 0; a < AUTHORS; a++) {
    const key = feedIdKey({ officeId: OFFICE, author: `node-${a}`, kind: `session:${buildTeamSessionKey(`app-${a}`, OFFICE, 'e1')}` })
    digest.push([key, ENTRIES])
    const entries: FeedEntry[] = []
    for (let s = 1; s <= ENTRIES; s++) entries.push({ seq: s, hlc: s.toString(16).padStart(16, '0'), fid: `f-${a}-${s}`, type: 'msg', payload: { seq: s, role: 'assistant', content: 'x'.repeat(1200) }, ts: s })
    frames.push({ kind: 'feed-entries', officeId: OFFICE, feedKey: key, entries, upToSeq: ENTRIES, more: false, truncatedBeforeSeq: 0 })
  }
  const subscribed: string[] = []
  const probe = createSessionFeed({
    officeId: OFFICE, selfNodeId: 'probe', feedStore: stores().feed,
    sendToPeer: (_p, f) => { if (f.kind === 'feed-subscribe') subscribed.push(f.feedKey) }, broadcast: () => {},
    readOwnedTranscript: () => null, isSessionActive: () => false,
    servesMirror: () => false, acceptEntriesFrom: () => true, retransmitIntervalMs: 0,
    wantsReplica: (key) => key === watched,
  })
  probe.handleFrame('authority', { kind: 'feed-digest', officeId: OFFICE, feeds: digest })
  // The authority serves only what was subscribed.
  for (const frame of frames) if (frame.kind === 'feed-entries' && subscribed.includes(frame.feedKey)) feed.handleFrame('authority', frame)
  check(subscribed.length === 1, `lazy: ${subscribed.length} feeds subscribed from a digest of ${AUTHORS} (want 1)`)
  check(applied === ENTRIES, `lazy: applied ${applied} entries (want ${ENTRIES}, the one watched transcript)`)
  const digestBytes = JSON.stringify({ kind: 'feed-digest', officeId: OFFICE, feeds: digest }).length
  console.log(
    `[lazy] ${AUTHORS} authors × ${ENTRIES} entries, 1 panel open: subscribed=${subscribed.length} applied=${applied} ` +
      `(full replication before: ${AUTHORS * ENTRIES}); discovery = one ${Math.round(digestBytes / 1024)} KB digest ` +
      `(before: ${AUTHORS} advertise frames)`
  )
  feed.stop()
  probe.stop()
  joiner.dbm.closeAll()
}

boardCatchup()
transcriptReplication()
lazyReplication()
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`)
  process.exit(1)
}
console.log('ok')
