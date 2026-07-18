/** apps/federation -- Database migrations. */

import type { Migration } from '../../platform/store'

export const MIGRATION_NAMESPACE = 'app_federation'

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Create office federation tables (office_nodes, office_credentials)',
    up(db) {
      // joined_at ordering supports election by join order; identity is the
      // portable Identity.id, not a device key.
      db.exec(`
        CREATE TABLE office_nodes (
          node_id TEXT PRIMARY KEY,
          office_id TEXT NOT NULL,
          identity TEXT NOT NULL,
          display_name TEXT,
          joined_at INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'online'
        )
      `)
      db.exec(`
        CREATE INDEX idx_office_nodes_office
          ON office_nodes(office_id, joined_at)
      `)

      // Issuance/revocation ledger for office credentials (independent from PIN).
      db.exec(`
        CREATE TABLE office_credentials (
          jti TEXT PRIMARY KEY,
          office_id TEXT NOT NULL,
          identity TEXT NOT NULL,
          scope_json TEXT NOT NULL,
          exp INTEGER,
          issued_at INTEGER NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0
        )
      `)
      db.exec(`
        CREATE INDEX idx_office_credentials_office
          ON office_credentials(office_id)
      `)
    }
  },
  {
    version: 2,
    description: 'M2: blackboard replication log + per-office authority/term state',
    up(db) {
      // Replication log: the durable, reliable channel under the existing
      // `team:blackboard` UI event. The single writer (authority) assigns a
      // per-office monotonic `seq`; `term` is the authority tenure for
      // cross-tenure staleness rejection; `fid` is the cross-restart unique
      // dedup key; `task_id` lets the brain-split probe detect duplicate task ids.
      db.exec(`
        CREATE TABLE blackboard_replication_log (
          office_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          term INTEGER NOT NULL,
          op TEXT NOT NULL,
          payload TEXT NOT NULL,
          fid TEXT NOT NULL,
          task_id TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (office_id, seq)
        )
      `)
      // Idempotent apply: (office_id, fid) guards re-apply of a retransmit /
      // handover replay across the whole log, complementing the (office_id, seq)
      // monotonic check.
      db.exec(`
        CREATE UNIQUE INDEX idx_repl_log_office_fid
          ON blackboard_replication_log(office_id, fid)
      `)
      db.exec(`
        CREATE INDEX idx_repl_log_office_task
          ON blackboard_replication_log(office_id, task_id)
      `)

      // Per-office authority/term state: the believed authority, the current
      // tenure (term), the replicated roster version (rosterEpoch, the
      // last-known-roster quorum basis), and the two replication water marks —
      // applied_seq (optimistic local) and committed_seq (quorum-acked, the
      // handover continuity baseline).
      db.exec(`
        CREATE TABLE office_authority (
          office_id TEXT PRIMARY KEY,
          term INTEGER NOT NULL DEFAULT 0,
          authority_node_id TEXT,
          roster_epoch INTEGER NOT NULL DEFAULT 0,
          committed_seq INTEGER NOT NULL DEFAULT 0,
          applied_seq INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        )
      `)
    }
  },
  {
    version: 3,
    description: 'Joined-office connections (cross-restart re-join recovery)',
    up(db) {
      // What this node needs to re-join an office it is a member of after a
      // restart: the host endpoint, the credential token, and the apps it brought
      // in. The token is an at-rest secret — the store wraps it with the credential
      // envelope on write (encrypted in enterprise, plaintext-passthrough in
      // open-source). A row exists only while the node intends to stay; it is
      // deleted on explicit exit (leave / office dissolved / kicked with no
      // brought members left).
      db.exec(`
        CREATE TABLE joined_office_connections (
          office_id TEXT PRIMARY KEY,
          server_url TEXT NOT NULL,
          invite_token TEXT NOT NULL,
          bring_app_ids TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
    }
  },
  {
    version: 4,
    description: 'office_nodes: composite primary key (office_id, node_id)',
    up(db) {
      // A node can host one office and be joined to others at the same time; the
      // original single-column node_id key made those rows overwrite each other
      // across offices (corrupting election rosters and reachability checks).
      // SQLite cannot alter a primary key in place, so rebuild the table.
      //
      // Bare copy (no row filtering) is safe ONLY because of two preconditions —
      // do not copy this pattern without them (see app_runtime v4 for the
      // filtered variant): no FK references office_nodes in either direction,
      // so no row can violate a constraint under the migration transaction's
      // foreign_keys=ON; and the old single-column node_id PK guarantees the
      // new composite key cannot collide.
      db.exec(`
        CREATE TABLE office_nodes_new (
          office_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          identity TEXT NOT NULL,
          display_name TEXT,
          joined_at INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'online',
          PRIMARY KEY (office_id, node_id)
        )
      `)
      db.exec(`
        INSERT INTO office_nodes_new (office_id, node_id, identity, display_name, joined_at, last_seen, status)
          SELECT office_id, node_id, identity, display_name, joined_at, last_seen, status FROM office_nodes
      `)
      db.exec(`DROP TABLE office_nodes`)
      db.exec(`ALTER TABLE office_nodes_new RENAME TO office_nodes`)
      db.exec(`
        CREATE INDEX idx_office_nodes_office
          ON office_nodes(office_id, joined_at)
      `)
    }
  },
  {
    version: 5,
    description: 'office_nodes: advertised reachable URL (transport re-form address book)',
    up(db) {
      // Each node advertises the base URL of its own HTTP/WS server at join, so
      // survivors can DIAL a peer (e.g. a newly-elected authority) after the
      // host is gone. NULL when the node runs no reachable server — such a node
      // can dial out but cannot be dialed.
      db.exec(`ALTER TABLE office_nodes ADD COLUMN advertised_url TEXT`)
    }
  },
  {
    version: 6,
    description: 'Unified feed log substrate (per-author append-only feeds + cursors + cache)',
    up(db) {
      // feed_log: entries this node AUTHORS for a feed = the durable outbox. One
      // row per (office, feed, seq); seq is per-feed monotonic assigned by the
      // author and survives process restart (fixing the in-memory seq-reset that
      // let viewers silently drop post-restart frames). `hlc` is the packed,
      // lexicographically-sortable hybrid logical clock (physical ms + logical
      // counter) that gives cross-author causal order without a wall-clock race;
      // `ts` is the author wall clock kept for display only. `fid` is the
      // cross-restart globally-unique idempotency key.
      db.exec(`
        CREATE TABLE feed_log (
          office_id TEXT NOT NULL,
          feed_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          hlc TEXT NOT NULL,
          fid TEXT NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          ts INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (office_id, feed_id, seq)
        )
      `)
      // Idempotent append: (office, feed, fid) guards a retransmit/replay from
      // creating a second row, complementing the (office, feed, seq) monotonic PK.
      db.exec(`
        CREATE UNIQUE INDEX idx_feed_log_fid
          ON feed_log(office_id, feed_id, fid)
      `)

      // feed_peer_cursor: per-peer DELIVERY watermark for feeds this node authors.
      // acked_seq is the highest contiguous seq the peer has confirmed; the
      // producer resends everything above it on reconnect / retransmit tick, so a
      // dropped frame is redelivered instead of lost.
      db.exec(`
        CREATE TABLE feed_peer_cursor (
          office_id TEXT NOT NULL,
          feed_id TEXT NOT NULL,
          peer_node TEXT NOT NULL,
          acked_seq INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (office_id, feed_id, peer_node)
        )
      `)

      // feed_local_cursor: APPLIED watermark for REMOTE feeds this node consumes.
      // On (re)subscribe the consumer sends afterSeq = applied_seq so the author
      // replays only the tail — the one mechanism serving reconnect gap-fill,
      // history load, and late-join backfill alike.
      db.exec(`
        CREATE TABLE feed_local_cursor (
          office_id TEXT NOT NULL,
          feed_id TEXT NOT NULL,
          applied_seq INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (office_id, feed_id)
        )
      `)

      // feed_cache: viewer-side persistent copy of a remote feed's entries
      // (transcript/messages). History is immutable, so this cache never
      // invalidates — reopening a panel shows the cache instantly and only the
      // tail is pulled.
      db.exec(`
        CREATE TABLE feed_cache (
          office_id TEXT NOT NULL,
          feed_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          entry_json TEXT NOT NULL,
          PRIMARY KEY (office_id, feed_id, seq)
        )
      `)

      // feed_meta: per-feed high-water marks. truncated_before_seq is the
      // retention floor (entries at/below it are pruned once all peers acked);
      // hlc_high persists the clock so it cannot regress across a restart even if
      // the log tail was truncated.
      db.exec(`
        CREATE TABLE feed_meta (
          office_id TEXT NOT NULL,
          feed_id TEXT NOT NULL,
          truncated_before_seq INTEGER NOT NULL DEFAULT 0,
          hlc_high TEXT,
          PRIMARY KEY (office_id, feed_id)
        )
      `)
    }
  }
]
