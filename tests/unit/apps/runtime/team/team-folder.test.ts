/**
 * Unit tests for runtime/team team-folder — where a collaboration's in-between
 * files live on this machine, and when they go away.
 *
 * Proven:
 *   - the folder id is stable for one piece of work and differs across epochs
 *     and teams, so two runs never share drafts;
 *   - member folder names survive every file system: path separators, control
 *     and Windows-reserved characters are removed, Chinese is kept, an empty
 *     result falls back to the app id, over-long names are cut;
 *   - two members whose names reduce to one folder (case-insensitively) get two
 *     folders — the earlier member keeps the plain name;
 *   - `forMember` creates the member's own folder, and answers null for an app
 *     that is not on the roster;
 *   - `remove` deletes exactly the given pieces of work;
 *   - `prune` deletes only folders no epoch accounts for, never a live one, a
 *     fresh one, or anything it did not name.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  createTeamFolders,
  memberFolderName,
  teamFolderDir,
  teamFolderId,
} from '../../../../../src/main/apps/runtime/team/team-folder'

type Member = { appId: string; memberName: string; addedAt: number; origin?: 'local' | 'remote'; ownerNodeId?: string }

function member(appId: string, memberName: string, addedAt = 1): Member {
  return { appId, memberName, addedAt }
}

describe('team-folder', () => {
  describe('teamFolderId', () => {
    it('is stable per piece of work and distinct across epochs and teams', () => {
      const a = teamFolderId('team-1', 'epoch-1')
      expect(a).toMatch(/^[0-9a-f]{12}$/)
      expect(teamFolderId('team-1', 'epoch-1')).toBe(a)
      expect(teamFolderId('team-1', 'epoch-2')).not.toBe(a)
      expect(teamFolderId('team-2', 'epoch-1')).not.toBe(a)
      // The separator keeps the two halves from sliding into each other.
      expect(teamFolderId('ab', 'c')).not.toBe(teamFolderId('a', 'bc'))
    })
  })

  describe('memberFolderName', () => {
    const name = (memberName: string, appId = 'a1b2c3d4-e5f6') =>
      memberFolderName(member(appId, memberName), [member(appId, memberName)])

    it('keeps an ordinary name, including Chinese', () => {
      expect(name('reviewer')).toBe('reviewer')
      expect(name('代码审查员')).toBe('代码审查员')
    })

    it('removes path separators, control and Windows-forbidden characters', () => {
      expect(name('../evil')).toBe('evil')
      expect(name('a/b\\c')).toBe('abc')
      expect(name('what<>:"|?*now')).toBe('whatnow')
      expect(name('tab\there')).toBe('tabhere')
      expect(name('  .trimmed.  ')).toBe('trimmed')
    })

    it('falls back to the app id when nothing survives', () => {
      expect(name('../..', 'a1b2c3d4-e5f6')).toBe('a1b2c3d4')
      expect(name('   ', 'a1b2c3d4-e5f6')).toBe('a1b2c3d4')
    })

    it('tells a Windows device name apart', () => {
      expect(name('con', 'a1b2c3d4')).toBe('con-a1b2c3d4')
      expect(name('LPT1.txt', 'a1b2c3d4')).toBe('LPT1.txt-a1b2c3d4')
    })

    it('cuts an over-long name', () => {
      expect(Array.from(name('x'.repeat(200))).length).toBe(64)
      expect(Array.from(name('审'.repeat(200))).length).toBe(64)
    })

    it('gives two members that reduce to one folder two folders', () => {
      const first = member('app-first-1', 'Reviewer', 1)
      const later = member('app-later-2', 'reviewer', 2)
      const roster = [first, later]
      expect(memberFolderName(first, roster)).toBe('Reviewer')
      expect(memberFolderName(later, roster)).toBe('reviewer-applater')
    })
  })

  describe('createTeamFolders', () => {
    let root: string
    const teams: Array<{ id: string }> = []
    const epochs = new Map<string, Array<{ id: string }>>()
    const members = new Map<string, Member[]>()
    const tasks = new Map<string, { teamId: string; epochId: string; assigneeAppId: string | null }>()
    const store = {
      getTaskById: (id: string) => (tasks.get(id) ?? null) as never,
      listTeams: () => teams as never,
      listEpochsByTeam: (teamId: string) => (epochs.get(teamId) ?? []) as never,
      listMembersByTeam: (teamId: string) => (members.get(teamId) ?? []) as never,
    }

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'halo-team-folder-')))
      teams.length = 0
      tasks.clear()
      epochs.clear()
      members.clear()
      teams.push({ id: 'team-1' })
      epochs.set('team-1', [{ id: 'epoch-1' }, { id: 'epoch-2' }])
      members.set('team-1', [member('app-writer', 'writer'), member('app-reviewer', 'reviewer')])
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('creates the member folder it hands out', () => {
      const folders = createTeamFolders({ store, root })
      const paths = folders.forMember('team-1', 'epoch-1', 'app-reviewer')
      expect(paths).not.toBeNull()
      expect(paths!.shared).toBe(teamFolderDir(root, 'team-1', 'epoch-1'))
      expect(paths!.self).toBe(join(paths!.shared, 'reviewer'))
      expect(existsSync(paths!.self)).toBe(true)
      expect(folders.sharedDir('team-1', 'epoch-1')).toBe(paths!.shared)
    })

    it('names a local task assignee\u2019s folder without creating it, and nothing for a remote one', () => {
      members.set('team-1', [
        member('app-writer', 'writer'),
        { ...member('app-far', 'far'), origin: 'remote', ownerNodeId: 'node-far' } as Member,
      ])
      tasks.set('t-local', { teamId: 'team-1', epochId: 'epoch-1', assigneeAppId: 'app-writer' })
      tasks.set('t-remote', { teamId: 'team-1', epochId: 'epoch-1', assigneeAppId: 'app-far' })
      tasks.set('t-other-epoch', { teamId: 'team-1', epochId: 'epoch-2', assigneeAppId: 'app-writer' })
      const folders = createTeamFolders({ store, root })

      const dir = folders.ofTaskAssignee('team-1', 'epoch-1', 't-local')
      expect(dir).toBe(join(teamFolderDir(root, 'team-1', 'epoch-1'), 'writer'))
      expect(existsSync(dir!)).toBe(false)
      expect(folders.ofTaskAssignee('team-1', 'epoch-1', 't-remote')).toBeNull()
      expect(folders.ofTaskAssignee('team-1', 'epoch-1', 't-other-epoch')).toBeNull()
      expect(folders.ofTaskAssignee('team-1', 'epoch-1', 'missing')).toBeNull()
    })

    it('answers null for an app that is not on the roster', () => {
      const folders = createTeamFolders({ store, root })
      expect(folders.forMember('team-1', 'epoch-1', 'app-stranger')).toBeNull()
    })

    it('answers null rather than a folder it could not create', () => {
      writeFileSync(join(root, 'blocked'), 'a file where the root should be')
      const folders = createTeamFolders({ store, root: join(root, 'blocked') })
      expect(folders.forMember('team-1', 'epoch-1', 'app-reviewer')).toBeNull()
    })

    it('removes exactly the given pieces of work', async () => {
      const folders = createTeamFolders({ store, root })
      const one = folders.forMember('team-1', 'epoch-1', 'app-writer')!
      const two = folders.forMember('team-1', 'epoch-2', 'app-writer')!
      writeFileSync(join(one.self, 'notes.md'), 'x')

      await folders.remove('team-1', ['epoch-1'])
      expect(existsSync(one.shared)).toBe(false)
      expect(existsSync(two.shared)).toBe(true)
    })

    it('prunes only old folders no epoch accounts for', async () => {
      const folders = createTeamFolders({ store, root })
      const live = folders.forMember('team-1', 'epoch-1', 'app-writer')!
      const orphan = teamFolderDir(root, 'gone-team', 'gone-epoch')
      const freshOrphan = teamFolderDir(root, 'gone-team', 'new-epoch')
      const foreign = join(root, 'not-ours')
      for (const dir of [orphan, freshOrphan, foreign]) mkdirSync(dir, { recursive: true })
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      for (const dir of [live.shared, orphan, foreign]) utimesSync(dir, old, old)

      await folders.prune()
      expect(existsSync(live.shared)).toBe(true)
      expect(existsSync(orphan)).toBe(false)
      expect(existsSync(freshOrphan)).toBe(true)
      expect(existsSync(foreign)).toBe(true)
    })

    it('prunes nothing when the root does not exist yet', async () => {
      const folders = createTeamFolders({ store, root: join(root, 'missing') })
      await expect(folders.prune()).resolves.toBeUndefined()
    })
  })
})
