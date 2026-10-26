/**
 * The duty a digital human of this computer had in a team hosted elsewhere is
 * kept when it is taken out of that team, and given back when it joins the same
 * team again — the user wrote it, and without it the member is mute there.
 *
 * The rules under test: only the members this computer owns get one back; the
 * team is recognised by its id, which every invite to it carries; a duty is
 * given back once, and only to a member re-entering the office, never over a
 * row that is still there; while the member still has a row its kept copy
 * follows the owner's edits (a cleared duty forgets it), so the kept copy is
 * never older than one the office may still hold; and a roster still listing a
 * member that left neither gives its duty back nor uses it up. Kept on disk
 * beside halo.db, so a restart in between loses nothing — and no schema change.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'

const OFFICE = 'office-1'
const OTHER_OFFICE = 'office-2'
const HOST = 'node-host'
const SELF = 'node-self'
const MINE = 'app-mine'
const MINE_TOO = 'app-mine-too'
const THEIRS = 'app-theirs'

const managers: DatabaseManager[] = []
const dirs: string[] = []

function makeStore(path = ':memory:'): TeamStore {
  const dbm = createDatabaseManager(path)
  managers.push(dbm)
  const db = dbm.getAppDatabase()
  dbm.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  return new TeamStore(db)
}

afterEach(() => {
  while (managers.length > 0) managers.pop()!.closeAll()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function roster(
  members: Array<{ appId: string; owner: string; duty?: string | null }>,
  officeId = OFFICE
) {
  return {
    hostNodeId: HOST,
    selfNodeId: SELF,
    snapshot: {
      team: { id: officeId, name: 'Delivery', goal: 'ship', leadAppId: null, collabMode: 'free' as const, hostNodeId: HOST },
      members: members.map((m) => ({
        appId: m.appId,
        memberName: m.appId,
        role: '',
        isLead: false,
        duty: m.duty ?? null,
        ownerNodeId: m.owner,
        memberIdentity: m.owner === SELF ? null : 'id-host',
        ownerDisplayName: null,
      })),
      edges: [],
    },
  }
}

const dutyOf = (store: TeamStore, appId: string, officeId = OFFICE) => store.getMember(officeId, appId)?.duty ?? null

describe('duty kept for a member taken out of a joined team', () => {
  it('comes back when the member joins the same team again', () => {
    const store = makeStore()
    store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }, { appId: THEIRS, owner: HOST }]))
    store.updateMemberFields(OFFICE, MINE, { duty: 'You write the code.' })

    store.retainMemberDuties(OFFICE, [{ appId: MINE, duty: 'You write the code.' }])
    store.purgeJoinedOffice(OFFICE)
    // A rejoin lands with no duty: the join request carries none, so the
    // office starts the member empty.
    const result = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }, { appId: THEIRS, owner: HOST }]))

    expect(dutyOf(store, MINE)).toBe('You write the code.')
    expect(result.dutiesRestored).toEqual([MINE])
  })

  it('comes back for a member taken out alone, while the rest of this computer stays', () => {
    const store = makeStore()
    store.materializeJoinedOffice(roster([
      { appId: MINE, owner: SELF, duty: 'You write the code.' },
      { appId: MINE_TOO, owner: SELF, duty: 'You review it.' },
    ]))

    store.retainMemberDuties(OFFICE, [{ appId: MINE, duty: 'You write the code.' }])
    // The office drops the member it was asked to take out…
    store.materializeJoinedOffice(roster([{ appId: MINE_TOO, owner: SELF, duty: 'You review it.' }]))
    expect(store.getMember(OFFICE, MINE)).toBeNull()
    // …and has it again, empty, once it rejoins.
    const result = store.materializeJoinedOffice(roster([
      { appId: MINE, owner: SELF },
      { appId: MINE_TOO, owner: SELF, duty: 'You review it.' },
    ]))

    expect(dutyOf(store, MINE)).toBe('You write the code.')
    expect(dutyOf(store, MINE_TOO)).toBe('You review it.')
    expect(result.dutiesRestored).toEqual([MINE])
  })

  it('is given back once', () => {
    const store = makeStore()
    store.retainMemberDuties(OFFICE, [{ appId: MINE, duty: 'You write the code.' }])
    store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }]))

    // Out again without anything kept (a kick by the host), then back.
    store.materializeJoinedOffice(roster([{ appId: THEIRS, owner: HOST }]))
    const result = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }]))

    expect(dutyOf(store, MINE)).toBeNull()
    expect(result.dutiesRestored).toEqual([])
  })

  it('replaces an older copy the office still holds, since only this computer writes it', () => {
    const store = makeStore()
    store.retainMemberDuties(OFFICE, [{ appId: MINE, duty: 'The duty as last written.' }])

    // The office never heard the member leave, nor the last edit before it.
    const result = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF, duty: 'An older duty.' }]))

    expect(dutyOf(store, MINE)).toBe('The duty as last written.')
    expect(result.dutiesRestored).toEqual([MINE])
  })

  it('has nothing to tell the office when its copy is the one kept', () => {
    const store = makeStore()
    store.retainMemberDuties(OFFICE, [{ appId: MINE, duty: 'You write the code.' }])

    const result = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF, duty: 'You write the code.' }]))

    expect(dutyOf(store, MINE)).toBe('You write the code.')
    expect(result.dutiesRestored).toEqual([])
  })

  it('never lands on a member that never left', () => {
    const store = makeStore()
    store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF, duty: 'Current duty.' }]))
    store.retainMemberDuties(OFFICE, [{ appId: MINE, duty: 'Something else.' }])

    const result = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF, duty: 'Current duty.' }]))

    expect(dutyOf(store, MINE)).toBe('Current duty.')
    expect(result.dutiesRestored).toEqual([])
  })

  it('never gives a teammate’s member a duty from this computer', () => {
    const store = makeStore()
    store.retainMemberDuties(OFFICE, [{ appId: THEIRS, duty: 'Not ours to write.' }])

    const result = store.materializeJoinedOffice(roster([{ appId: THEIRS, owner: HOST }]))

    expect(dutyOf(store, THEIRS)).toBeNull()
    expect(result.dutiesRestored).toEqual([])
  })

  it('belongs to the one team it was written for', () => {
    const store = makeStore()
    store.retainMemberDuties(OFFICE, [{ appId: MINE, duty: 'You write the code.' }])

    const result = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }], OTHER_OFFICE))

    expect(dutyOf(store, MINE, OTHER_OFFICE)).toBeNull()
    expect(result.dutiesRestored).toEqual([])
  })

  it('keeps nothing for a member with no duty written', () => {
    const store = makeStore()
    store.retainMemberDuties(OFFICE, [{ appId: MINE, duty: '   ' }, { appId: MINE_TOO, duty: null }])

    const result = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }, { appId: MINE_TOO, owner: SELF }]))

    expect(result.dutiesRestored).toEqual([])
  })

  it('is not given back to a member that left in this joining, when a roster that is behind lists it', () => {
    const store = makeStore()
    store.retainMemberDuties(OFFICE, [{ appId: MINE, duty: 'You write the code.' }])

    const stale = store.materializeJoinedOffice({ ...roster([{ appId: MINE, owner: SELF }]), departed: new Set([MINE]) })
    expect(stale.dutiesRestored).toEqual([])
    expect(dutyOf(store, MINE)).toBeNull()

    // Still there for when it really rejoins.
    store.materializeJoinedOffice(roster([]))
    const rejoined = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }]))
    expect(rejoined.dutiesRestored).toEqual([MINE])
    expect(dutyOf(store, MINE)).toBe('You write the code.')
  })
})

describe('a kept duty follows the member’s row until it leaves', () => {
  // The member is still in the team: its removal is on the way, or never came.
  function stillInTeam(duty: string) {
    const store = makeStore()
    store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF, duty }, { appId: MINE_TOO, owner: SELF, duty: 'other' }]))
    store.retainMemberDuties(OFFICE, [{ appId: MINE, duty }])
    return store
  }
  const leavesThenRejoins = (store: TeamStore) => {
    store.materializeJoinedOffice(roster([{ appId: MINE_TOO, owner: SELF, duty: 'other' }]))
    return store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }, { appId: MINE_TOO, owner: SELF, duty: 'other' }]))
  }

  it('brings back the duty the owner wrote after taking it out, not the one it had then', () => {
    const store = stillInTeam('D1')
    store.updateMemberFields(OFFICE, MINE, { duty: 'D2' })

    const result = leavesThenRejoins(store)

    expect(dutyOf(store, MINE)).toBe('D2')
    expect(result.dutiesRestored).toEqual([MINE])
  })

  it('brings back nothing after the owner cleared the duty', () => {
    const store = stillInTeam('D1')
    store.updateMemberFields(OFFICE, MINE, { duty: null })

    const result = leavesThenRejoins(store)

    expect(dutyOf(store, MINE)).toBeNull()
    expect(result.dutiesRestored).toEqual([])
  })

  it('brings back nothing when leaving with no duty after an older one was kept', () => {
    const store = stillInTeam('D1')
    // What leaving does for a member whose duty is empty by then.
    expect(store.retainMemberDuties(OFFICE, [{ appId: MINE, duty: '' }])).toBe(0)

    const result = leavesThenRejoins(store)

    expect(dutyOf(store, MINE)).toBeNull()
    expect(result.dutiesRestored).toEqual([])
  })

  it('has nothing to tell the office when the roster brings it back with the duty last written', () => {
    const store = stillInTeam('D1')
    store.updateMemberFields(OFFICE, MINE, { duty: 'D2' })
    // Its local row goes without the office having removed it.
    store.removeMember(OFFICE, MINE)

    const result = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF, duty: 'D2' }, { appId: MINE_TOO, owner: SELF, duty: 'other' }]))

    expect(dutyOf(store, MINE)).toBe('D2')
    expect(result.dutiesRestored).toEqual([])
  })

  it('is left alone by a write arriving after the row is gone', () => {
    const store = stillInTeam('D1')
    store.materializeJoinedOffice(roster([{ appId: MINE_TOO, owner: SELF, duty: 'other' }]))
    // A late echo of an older profile write: no row to change.
    store.updateMemberFields(OFFICE, MINE, { duty: 'D0' })

    store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }, { appId: MINE_TOO, owner: SELF, duty: 'other' }]))

    expect(dutyOf(store, MINE)).toBe('D1')
  })

  it('keeps nothing new for a member with nothing kept', () => {
    const store = makeStore()
    store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF, duty: 'D1' }]))
    store.updateMemberFields(OFFICE, MINE, { duty: 'D2' })
    store.materializeJoinedOffice(roster([]))

    const result = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }]))

    expect(dutyOf(store, MINE)).toBeNull()
    expect(result.dutiesRestored).toEqual([])
  })
})

describe('duties kept on disk', () => {
  function dataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'halo-kept-duties-'))
    dirs.push(dir)
    return dir
  }

  it('outlive a restart, in a file beside halo.db', () => {
    const dir = dataDir()
    makeStore(join(dir, 'halo.db')).retainMemberDuties(OFFICE, [{ appId: MINE, duty: 'You write the code.' }])
    managers.pop()!.closeAll()

    const store = makeStore(join(dir, 'halo.db'))
    store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }]))

    expect(dutyOf(store, MINE)).toBe('You write the code.')
    expect(existsSync(join(dir, 'team-retained-duties.json'))).toBe(true)
  })

  it('stay given back after a restart', () => {
    const dir = dataDir()
    const first = makeStore(join(dir, 'halo.db'))
    first.retainMemberDuties(OFFICE, [{ appId: MINE, duty: 'You write the code.' }])
    first.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }]))
    managers.pop()!.closeAll()

    const store = makeStore(join(dir, 'halo.db'))
    store.materializeJoinedOffice(roster([{ appId: THEIRS, owner: HOST }]))
    const result = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }]))

    expect(result.dutiesRestored).toEqual([])
  })

  it('a damaged file keeps nothing and breaks nothing', () => {
    const dir = dataDir()
    writeFileSync(join(dir, 'team-retained-duties.json'), '{ not json', 'utf8')
    const store = makeStore(join(dir, 'halo.db'))

    const result = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }]))

    expect(result.dutiesRestored).toEqual([])
    expect(store.retainMemberDuties(OFFICE, [{ appId: MINE, duty: 'You write the code.' }])).toBe(1)
  })

  it('a file of the wrong shape keeps what is readable and breaks nothing', () => {
    const dir = dataDir()
    writeFileSync(join(dir, 'team-retained-duties.json'), JSON.stringify({
      [OFFICE]: 'not a team',
      [OTHER_OFFICE]: { [MINE]: { duty: 'Still readable.', keptAt: 1 }, [MINE_TOO]: { duty: 5 } },
    }), 'utf8')
    const store = makeStore(join(dir, 'halo.db'))

    const first = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }]))
    store.updateMemberFields(OFFICE, MINE, { duty: 'Edited.' })
    const other = store.materializeJoinedOffice(roster([{ appId: MINE, owner: SELF }, { appId: MINE_TOO, owner: SELF }], OTHER_OFFICE))

    expect(first.dutiesRestored).toEqual([])
    expect(other.dutiesRestored).toEqual([MINE])
    expect(dutyOf(store, MINE, OTHER_OFFICE)).toBe('Still readable.')
  })
})
