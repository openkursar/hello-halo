/**
 * apps/team -- Duties kept for members that left a team joined from elsewhere
 *
 * Leaving such a team deletes this computer's rows for it and the host deletes
 * its own, and the duty the owner wrote lived only there. Each one is kept here
 * by team id (the id every invite to the same team carries) and app id until
 * that member rejoins the team (DESIGN "A duty outlives leaving a joined team").
 *
 * A JSON file beside halo.db rather than a table: a new migration copies the
 * whole database on every machine's first start and stops older builds sharing
 * the data folder from opening it — too much for a few rows written when
 * someone leaves. Read on first use; every change is written through at once.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'

const LOG_TAG = '[TeamStore]'

interface Entry {
  duty: string
  keptAt: number
}

export interface RetainedDuties {
  /**
   * Keep these duties. An empty one keeps nothing and forgets one kept before:
   * it is what the owner left the member with. Returns how many were kept.
   */
  keep(teamId: string, duties: ReadonlyArray<{ appId: string; duty: string | null | undefined }>): number
  /** The duty kept for this member of this team, if any. */
  peek(teamId: string, appId: string): string | null
  /**
   * The member's row now holds this duty: a duty kept for it follows, and an
   * empty one forgets it. Keeps nothing for a member with nothing kept.
   */
  follow(teamId: string, appId: string, duty: string | null): void
  /** Forget what is kept for these members of this team. */
  release(teamId: string, appIds: readonly string[]): void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `filePath` null keeps them in memory only (an in-memory database's store). */
export function createRetainedDuties(filePath: string | null): RetainedDuties {
  let kept: Map<string, Map<string, Entry>> | null = null

  const load = (): Map<string, Map<string, Entry>> => {
    if (kept) return kept
    kept = new Map()
    if (!filePath || !existsSync(filePath)) return kept
    let skipped = 0
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
      for (const [teamId, team] of Object.entries(isRecord(parsed) ? parsed : {})) {
        if (!isRecord(team)) { skipped += 1; continue }
        const members = new Map<string, Entry>()
        for (const [appId, entry] of Object.entries(team)) {
          if (isRecord(entry) && typeof entry.duty === 'string') {
            members.set(appId, { duty: entry.duty, keptAt: typeof entry.keptAt === 'number' ? entry.keptAt : 0 })
          } else {
            skipped += 1
          }
        }
        if (members.size > 0) kept.set(teamId, members)
      }
    } catch (err) {
      console.warn(`${LOG_TAG} kept duties unreadable, starting without them path=${filePath}:`, err)
    }
    if (skipped > 0) console.warn(`${LOG_TAG} kept duties: skipped ${skipped} malformed entries path=${filePath}`)
    return kept
  }

  const save = (): void => {
    if (!filePath) return
    const tmp = `${filePath}.tmp`
    const out = Object.fromEntries([...load()].map(([teamId, members]) => [teamId, Object.fromEntries(members)]))
    try {
      writeFileSync(tmp, JSON.stringify(out), 'utf8')
      renameSync(tmp, filePath)
    } catch (err) {
      console.error(`${LOG_TAG} could not save kept duties path=${filePath}:`, err)
    }
  }

  // Returns whether anything was there to forget.
  const forget = (teamId: string, appId: string): boolean => {
    const members = load().get(teamId)
    if (!members?.delete(appId)) return false
    if (members.size === 0) load().delete(teamId)
    return true
  }

  return {
    keep(teamId, duties) {
      const all = load()
      let count = 0
      let changed = false
      for (const { appId, duty } of duties) {
        if (!duty?.trim()) {
          if (forget(teamId, appId)) changed = true
          continue
        }
        const members = all.get(teamId) ?? new Map<string, Entry>()
        members.set(appId, { duty, keptAt: Date.now() })
        all.set(teamId, members)
        count += 1
        changed = true
      }
      if (changed) save()
      return count
    },
    peek(teamId, appId) {
      return load().get(teamId)?.get(appId)?.duty ?? null
    },
    follow(teamId, appId, duty) {
      const entry = load().get(teamId)?.get(appId)
      if (!entry || entry.duty === duty) return
      if (duty?.trim()) Object.assign(entry, { duty, keptAt: Date.now() })
      else forget(teamId, appId)
      save()
    },
    release(teamId, appIds) {
      let changed = false
      for (const appId of appIds) if (forget(teamId, appId)) changed = true
      if (changed) save()
    },
  }
}
