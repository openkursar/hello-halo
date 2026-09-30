/**
 * The team folder: where a collaboration's in-between output lives — reviews,
 * reports, notes, drafts, anything written for a teammate rather than for the
 * project. Outside every member's working directory on purpose: a member's
 * working directory is often the user's own repository, and a review left there
 * is litter the user has to clean up.
 *
 *   <root>/<folder id>/<member folder>/...
 *
 * One folder per piece of work (team + epoch), hashed so the path stays short
 * enough for Windows and for a model to copy without mistakes. Inside it every
 * member owns one sub-folder: members on this machine may read each other's,
 * but each publishes only from its own, so a published `team:` ref carries its
 * producer's name and two members can never collide on one.
 *
 * The id is derived, never stored, so every machine of an office computes the
 * same folder for the same work, and a ref resolves on whichever machine holds
 * the file.
 */

import { createHash } from 'crypto'
import { mkdirSync } from 'fs'
import { readdir, rm, stat } from 'fs/promises'
import { join } from 'path'
import type { TeamStore } from '../../team'
import { isRemoteMember } from '../../../../shared/apps/team-types'

const LOG_TAG = '[TeamFolder]'

const FOLDER_ID_LENGTH = 12
const FOLDER_ID_PATTERN = /^[0-9a-f]{12}$/
const MEMBER_FOLDER_MAX_LENGTH = 64
// Device names Windows refuses as a file or folder name, with or without an extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
// A folder can be created before its epoch reaches the store, and then looks
// orphaned. Only a folder whose member sub-folders were all created longer ago
// than this is judged; writes inside a sub-folder do not count.
const PRUNE_MIN_AGE_MS = 60 * 60 * 1000

export interface TeamFolderPaths {
  /** The folder of this piece of work, shared by the members on this machine. */
  shared: string
  /** The caller's own sub-folder: the only place it publishes `team:` refs from. */
  self: string
}

export function teamFolderId(teamId: string, epochId: string): string {
  return createHash('sha256').update(`${teamId}\u0000${epochId}`).digest('hex').slice(0, FOLDER_ID_LENGTH)
}

export function teamFolderDir(root: string, teamId: string, epochId: string): string {
  return join(root, teamFolderId(teamId, epochId))
}

/** A member name reduced to what every file system accepts; empty when nothing survives. */
function sanitizeMemberName(memberName: string): string {
  const cleaned = memberName
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  return Array.from(cleaned).slice(0, MEMBER_FOLDER_MAX_LENGTH).join('').replace(/[\s.]+$/, '')
}

interface RosterEntry {
  appId: string
  memberName: string
  addedAt: number
}

/**
 * The sub-folder a member writes in, unique within the team even on a
 * case-insensitive file system: when two names reduce to the same folder, the
 * member that joined first keeps it and the later one is told apart by its app id.
 */
export function memberFolderName(self: RosterEntry, roster: readonly RosterEntry[]): string {
  const suffix = self.appId.replace(/[^0-9A-Za-z]/g, '').slice(0, 8) || 'member'
  const base = sanitizeMemberName(self.memberName)
  if (!base) return suffix
  if (WINDOWS_RESERVED.test(base)) return `${base}-${suffix}`
  const key = base.toLowerCase()
  const joinedEarlier = (other: RosterEntry) =>
    other.addedAt < self.addedAt || (other.addedAt === self.addedAt && other.appId < self.appId)
  const taken = roster.some(
    (other) =>
      other.appId !== self.appId && joinedEarlier(other) && sanitizeMemberName(other.memberName).toLowerCase() === key
  )
  return taken ? `${base}-${suffix}` : base
}

export interface TeamFolders {
  /**
   * A member's folders for this piece of work, created if missing so the path it
   * is told about can be written to at once. Null when it is not on the roster,
   * or the folder cannot be created — a member must never be pointed at a
   * folder it cannot write to.
   */
  forMember(teamId: string, epochId: string, appId: string): TeamFolderPaths | null
  /**
   * The folder of a task's assignee, for a ref attached to that task by someone
   * else (a lead finishing a member's task). Null when the task has no assignee
   * or the assignee runs on another machine — its file is not here to publish.
   * Never creates anything.
   */
  ofTaskAssignee(teamId: string, epochId: string, taskId: string): string | null
  /** Where a `team:` ref lives on this machine (lexical; existence is not checked). */
  sharedDir(teamId: string, epochId: string): string
  /** Delete the folders of the given pieces of work of one team. */
  remove(teamId: string, epochIds: readonly string[]): Promise<void>
  /** Delete every folder no epoch in the store accounts for any more. */
  prune(): Promise<void>
}

export function createTeamFolders(deps: {
  store: Pick<TeamStore, 'listMembersByTeam' | 'listTeams' | 'listEpochsByTeam' | 'getTaskById'>
  root: string
}): TeamFolders {
  const { store, root } = deps

  return {
    forMember(teamId, epochId, appId) {
      const roster = store.listMembersByTeam(teamId)
      const self = roster.find((m) => m.appId === appId)
      if (!self) return null
      const shared = teamFolderDir(root, teamId, epochId)
      const own = join(shared, memberFolderName(self, roster))
      try {
        mkdirSync(own, { recursive: true })
      } catch (err) {
        console.warn(`${LOG_TAG} could not create ${own}:`, (err as Error).message)
        return null
      }
      return { shared, self: own }
    },

    ofTaskAssignee(teamId, epochId, taskId) {
      const task = store.getTaskById(taskId)
      if (!task?.assigneeAppId || task.teamId !== teamId || task.epochId !== epochId) return null
      const roster = store.listMembersByTeam(teamId)
      const assignee = roster.find((m) => m.appId === task.assigneeAppId)
      if (!assignee || isRemoteMember(assignee)) return null
      return join(teamFolderDir(root, teamId, epochId), memberFolderName(assignee, roster))
    },

    sharedDir: (teamId, epochId) => teamFolderDir(root, teamId, epochId),

    async remove(teamId, epochIds) {
      for (const epochId of epochIds) {
        const dir = teamFolderDir(root, teamId, epochId)
        try {
          await rm(dir, { recursive: true, force: true })
        } catch (err) {
          console.warn(`${LOG_TAG} could not remove ${dir}:`, (err as Error).message)
        }
      }
    },

    async prune() {
      let entries: string[]
      try {
        entries = await readdir(root)
      } catch {
        return
      }
      const live = new Set<string>()
      for (const team of store.listTeams()) {
        for (const epoch of store.listEpochsByTeam(team.id)) live.add(teamFolderId(team.id, epoch.id))
      }
      const now = Date.now()
      let removed = 0
      for (const entry of entries) {
        // Only what this module names is its to delete.
        if (!FOLDER_ID_PATTERN.test(entry) || live.has(entry)) continue
        const dir = join(root, entry)
        try {
          if (now - (await stat(dir)).mtimeMs < PRUNE_MIN_AGE_MS) continue
          await rm(dir, { recursive: true, force: true })
          removed++
        } catch (err) {
          console.warn(`${LOG_TAG} could not prune ${dir}:`, (err as Error).message)
        }
      }
      if (removed > 0) console.log(`${LOG_TAG} pruned ${removed} folder(s) of work that no longer exists`)
    },
  }
}
