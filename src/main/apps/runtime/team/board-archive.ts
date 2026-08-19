/**
 * The complete recorded history of one piece of work, written out on demand so
 * an agent can reach what the board's recent window leaves out.
 *
 * The window exists to keep a board read cheap; this exists so that cheapness
 * costs nothing. Without it the tail is not merely unshown, it is unreachable:
 * no tool pages backwards, and the agent cannot tell an act it cannot see from
 * one that never happened. With it, the tail is a file — which the agent already
 * knows how to read a slice of and, more importantly, to SEARCH. "Did anyone
 * ever follow this up?" is a grep, and no paging parameter we could invent would
 * answer it as well.
 *
 * It is a PRINTOUT, never a second ledger. The database holds the record; this
 * is regenerated from it, safe to delete at any moment, and carries no state
 * worth persisting. Every decision below follows from that:
 *
 * - **Rebuilt whole, never appended to.** Acts replicate between machines and
 *   arrive out of order — a late row can sort BEFORE rows already written, so an
 *   append (or any offset-based delta) would silently skip or duplicate one. A
 *   rewrite of a few hundred rows costs nothing next to the turn that triggered
 *   it, and cannot be wrong.
 * - **Rewritten only when the count moved.** Consecutive reads with no new acts
 *   in between touch the disk zero times.
 * - **Same fields the board shows.** Message bodies stay out, exactly as they
 *   stay out of the snapshot: this changes what an agent can REACH, and must not
 *   quietly widen what it can see.
 * - **Scratch, not user data.** It is regenerable and single-reader, so it does
 *   not belong in a space, a project folder, or anyone's working directory.
 * - **One writer per file.** Several Halo instances share a machine's temp root
 *   while holding their own replica of the SAME work, so a name built from the
 *   work alone would have them overwriting each other's printout — and none
 *   would notice, since each remembers writing it and skips the rewrite. The
 *   writing instance is therefore part of the name.
 * - **Swapped in, never written in place.** The reader is a separate process and
 *   may open the file at any moment, including while a concurrent turn triggers
 *   a rewrite. Writing to a staging name and renaming over the printout leaves
 *   the reader with the previous complete copy or the new one, never half of
 *   either — and half a record reads as "this never happened", which is the one
 *   conclusion this file exists to prevent.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderActivityTable } from './board-render'
import type { TeamStore } from '../../team'

const LOG_TAG = '[BoardArchive]'

const DIR_NAME = 'halo-team-board'

/**
 * Age past which a leftover printout is swept at startup. Deliberately not "wipe
 * the directory": the decentralized test tier boots several real nodes that share
 * one temp root, and a blanket wipe would delete a sibling's live file. Anything
 * this old belongs to a previous run, and a file deleted too eagerly is rebuilt
 * on the next read anyway.
 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** What a bounded board read is not showing, and where all of it can be found. */
export interface BoardHistoryExport {
  /** Every act this piece of work holds, shown or not. */
  total: number
  /** The printout, or null when it could not be written (the count still stands). */
  path: string | null
}

export interface BoardArchive {
  /**
   * Null when nothing is being withheld — the caller showed everything, so there
   * is nothing to point at and no file is written.
   */
  materialize(teamId: string, epochId: string, shownCount: number): BoardHistoryExport | null
  /** Drop a finished piece of work's printout. */
  clearEpoch(epochId: string): void
  /** Remove printouts left behind by earlier runs. */
  sweep(): void
}

export interface BoardArchiveDeps {
  store: TeamStore
  /** Override the scratch directory (tests). Defaults to a namespaced temp dir. */
  dir?: string
  /**
   * Tells this instance's printouts apart from those of any other instance
   * sharing the scratch directory. Defaults to the process id, which is what
   * "another instance" means here. Tests set it to stand in for a second node.
   */
  instanceId?: string
}

export function createBoardArchive(deps: BoardArchiveDeps): BoardArchive {
  const { store } = deps
  const dir = deps.dir ?? join(tmpdir(), DIR_NAME)
  const instanceId = deps.instanceId ?? String(process.pid)

  /**
   * Per piece of work: the printout we wrote, and how many acts it holds. Taking
   * this as proof that the FILE is current rests on nobody else writing that
   * path — which is what the instance in its name buys.
   */
  const written = new Map<string, { path: string; count: number }>()

  function materialize(teamId: string, epochId: string, shownCount: number): BoardHistoryExport | null {
    let total: number
    try {
      total = store.countActivityByEpoch(teamId, epochId)
    } catch (err) {
      console.error(`${LOG_TAG} could not count history for epoch=${epochId}:`, err)
      return null
    }
    if (total <= shownCount) return null

    const previous = written.get(epochId)
    if (previous && previous.count === total && existsSync(previous.path)) {
      return { total, path: previous.path }
    }

    const path = previous?.path ?? join(dir, fileName(store, teamId, epochId, instanceId))
    try {
      mkdirSync(dir, { recursive: true })
      const staging = `${path}.writing`
      writeFileSync(staging, render(store, teamId, epochId), 'utf-8')
      renameSync(staging, path)
      written.set(epochId, { path, count: total })
      console.log(`${LOG_TAG} exported ${total} acts: team=${teamId} epoch=${epochId} → ${path}`)
      return { total, path }
    } catch (err) {
      // The count is still true and still worth telling the reader, so a failed
      // write degrades the answer rather than removing it.
      console.error(`${LOG_TAG} export failed for epoch=${epochId}:`, err)
      written.delete(epochId)
      return { total, path: null }
    }
  }

  function clearEpoch(epochId: string): void {
    const entry = written.get(epochId)
    if (!entry) return
    written.delete(epochId)
    try {
      rmSync(entry.path, { force: true })
    } catch (err) {
      console.error(`${LOG_TAG} could not remove ${entry.path}:`, err)
    }
  }

  function sweep(): void {
    try {
      if (!existsSync(dir)) return
      const cutoff = Date.now() - STALE_AFTER_MS
      let removed = 0
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        try {
          if (statSync(path).mtimeMs > cutoff) continue
          rmSync(path, { force: true })
          removed += 1
        } catch {
          // A file that vanished under us, or one another node is holding, is not
          // this sweep's business.
        }
      }
      if (removed > 0) console.log(`${LOG_TAG} swept ${removed} stale printout(s) from ${dir}`)
    } catch (err) {
      console.error(`${LOG_TAG} sweep failed:`, err)
    }
  }

  return { materialize, clearEpoch, sweep }
}

/**
 * Readable enough to open by hand while debugging, and unique by epoch id AND by
 * writing instance — the first so two pieces of work (or two teams sharing a
 * name) never land on one file, the second so two instances holding their own
 * replica of the same work never do either.
 */
function fileName(store: TeamStore, teamId: string, epochId: string, instanceId: string): string {
  let slug = ''
  try {
    slug = filenameSafe(store.getTeamById(teamId)?.name ?? '').slice(0, 24)
  } catch {
    /* naming is cosmetic; the ids below are what make it unique */
  }
  return `${slug || 'team'}-${filenameSafe(epochId) || 'work'}-${filenameSafe(instanceId) || 'self'}.md`
}

function filenameSafe(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function render(store: TeamStore, teamId: string, epochId: string): string {
  const acts = store.listActivityByEpoch(teamId, epochId)
  const names = new Map(store.listMembersByTeam(teamId).map((m) => [m.appId, m.memberName]))
  const nameOf = (appId: string | null | undefined): string => (!appId ? '—' : names.get(appId) ?? appId)

  return [
    '# Team record — complete history of this piece of work',
    '',
    `${acts.length} entries, oldest first. Exported ${new Date().toISOString()} from the team record; ` +
      'the live board holds only the most recent ones.',
    '',
    'This is what was WRITTEN DOWN. Someone may have done work and not recorded it, ' +
      'so an entry missing from here is not proof that nothing happened.',
    '',
    acts.length === 0
      ? 'No entries.'
      : renderActivityTable(acts, nameOf, (at) => new Date(at).toISOString()),
    '',
  ].join('\n')
}
