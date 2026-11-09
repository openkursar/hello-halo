import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { createCollaborationSourceBindings } from '../../../../src/main/apps/team/source-bindings'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()))
function open(directory = ':memory:') {
  const manager = createDatabaseManager(directory)
  const db = manager.getAppDatabase()
  manager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  cleanups.push(() => manager.closeAll())
  return { manager, db, bindings: createCollaborationSourceBindings(db) }
}
import { buildTeamSessionKey } from '../../../../src/shared/apps/im-keys'

const binding = (requestId: string) => ({ requestId, sourceKey: 'original-chat', scopeKey: 'im:instance', ownerKey: 'person', payload: { kind: 'im', sender: 'private-caller', authority: 'private-hash' } })

it('keeps source authority immutable and resolves nested work to the nearest binding', () => {
  const { bindings } = open()
  bindings.bind(binding('request'))
  bindings.bind(binding('request'))
  expect(bindings.get('request/child/grandchild')).toMatchObject({ ...binding('request'), revoked: false })
  expect(() => bindings.bind({ ...binding('request'), sourceKey: 'other-chat' })).toThrow('cannot replace')
  expect(() => bindings.bind({ ...binding('request/child'), sourceKey: 'other-chat' })).toThrow('cannot replace')
  expect(bindings.revokeRequest('request')).toBe(1)
  expect(() => bindings.bind(binding('request'))).toThrow('cannot replace')
  expect(() => bindings.bind(binding('request/new-child'))).toThrow('cannot replace')
})

it('binds a host-owned member return path without replacing its IM ancestor', () => {
  const { bindings } = open()
  bindings.bind(binding('request'))
  const child = { requestId: 'request/assistant', sourceKey: buildTeamSessionKey('member', 'team', 'epoch'),
    scopeKey: 'team:team:epoch', ownerKey: 'member', payload: { parentRequestId: 'request', origin: 'guest' } }
  expect(() => bindings.bind(child)).toThrow('cannot replace')
  bindings.bind(child, 'request')
  expect(bindings.get('request/assistant/work')?.sourceKey).toBe(child.sourceKey)
  expect(bindings.get('request')?.sourceKey).toBe('original-chat')
  expect(() => bindings.bind({ ...child, requestId: 'unrelated' }, 'request')).toThrow('parent member request')
  expect(() => bindings.bind({ ...child, requestId: 'request/other', ownerKey: 'other' }, 'request')).toThrow('parent member request')
  bindings.revokeRequest('request')
  expect(() => bindings.bind({ ...child, requestId: 'request/new' }, 'request')).toThrow('cannot replace')
})

it('treats request identity characters literally when revoking a branch', () => {
  const { bindings } = open()
  for (const id of ['a_b', 'a_b/child', 'acb', 'acb/child']) bindings.bind(binding(id))
  expect(bindings.revokeRequest('a_b')).toBe(2)
  expect(bindings.get('acb/child')?.revoked).toBe(false)
  expect(bindings.get('a_b/child')?.revoked).toBe(true)
})

it.each(['request', 'source', 'scope', 'owner'] as const)('erases private payloads on %s revocation while retaining the rejection record', kind => {
  const { db, bindings } = open()
  bindings.bind(binding('request'))
  bindings.bind(binding('request/child'))
  if (kind === 'request') bindings.revokeRequest('request')
  if (kind === 'source') bindings.revokeSource('original-chat')
  if (kind === 'scope') bindings.revokeScope('im:instance')
  if (kind === 'owner') bindings.revokeOwner('person')

  const rows = db.prepare('SELECT payload_json, revoked FROM collaboration_source_bindings').all()
  expect(rows).toEqual([{ payload_json: '{}', revoked: 1 }, { payload_json: '{}', revoked: 1 }])
  expect(bindings.get('request/child')).toMatchObject({ revoked: true, payload: {} })
  expect(() => bindings.bind(binding('request'))).toThrow('cannot replace')
  expect(() => bindings.bind(binding('request/new-child'))).toThrow('cannot replace')
})

it('persists revocation across reopening without applying it to later human requests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'collaboration-source-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const first = open(join(directory, 'sources.db'))
  first.bindings.bind(binding('old-request'))
  expect(first.bindings.revokeScope('im:instance')).toEqual(['old-request'])
  first.manager.closeAll()
  const second = open(join(directory, 'sources.db'))
  expect(second.bindings.get('old-request/child')?.revoked).toBe(true)
  expect(() => second.bindings.bind(binding('old-request'))).toThrow('cannot replace')
  second.bindings.bind(binding('new-request'))
  expect(second.bindings.get('new-request')?.revoked).toBe(false)
  expect(second.bindings.revokeOwner('person')).toEqual(['new-request'])
})
