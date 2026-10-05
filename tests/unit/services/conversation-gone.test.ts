/**
 * isConversationGone: only a readable conversation folder without the file
 * proves a conversation is gone; a space that cannot be seen proves nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const spaces = new Map<string, { id: string; path: string; isTemp: boolean }>()

vi.mock('fs', async importOriginal => {
  const fs = await importOriginal<typeof import('fs')>()
  return { ...fs, statSync: vi.fn(fs.statSync) }
})

vi.mock('../../../src/main/services/space.service', () => ({
  getSpace: (spaceId: string) => spaces.get(spaceId) ?? null,
  touchSpaceActivity: () => undefined,
}))
vi.mock('../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [] }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getConfig: () => undefined }))

import { isConversationGone } from '../../../src/main/services/conversation.service'

describe('isConversationGone', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conv-gone-'))
    spaces.clear()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('is false while the conversation file exists', () => {
    const dir = join(root, 'temp', 'conversations')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'c1.json'), '{}')
    spaces.set('halo-temp', { id: 'halo-temp', path: join(root, 'temp'), isTemp: true })

    expect(isConversationGone('halo-temp', 'c1')).toBe(false)
  })

  it('is true when the folder is there without the file', () => {
    mkdirSync(join(root, 'proj', '.halo', 'conversations'), { recursive: true })
    spaces.set('s1', { id: 's1', path: join(root, 'proj'), isTemp: false })

    expect(isConversationGone('s1', 'c1')).toBe(true)
  })

  it('is true when the space no longer exists', () => {
    expect(isConversationGone('deleted-space', 'c1')).toBe(true)
  })

  it.each([
    'app-chat:a1',
    'app-chat:a1:local:direct:s1',
    'app-chat:a1:wecom:direct:user1',
    'app-chat:a1:team:t1:e1',
    'app-run:a1:r1',
  ])('does not judge another conversation family as a missing file: %s', (id) => {
    expect(isConversationGone('deleted-space', id)).toBe(false)
    mkdirSync(join(root, 'temp', 'conversations'), { recursive: true })
    spaces.set('halo-temp', { id: 'halo-temp', path: join(root, 'temp'), isTemp: true })
    expect(isConversationGone('halo-temp', id)).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('does not mistake an inaccessible file for a deleted conversation', () => {
    const dir = join(root, 'temp', 'conversations')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'c1.json'), '{}')
    spaces.set('halo-temp', { id: 'halo-temp', path: join(root, 'temp'), isTemp: true })
    chmodSync(dir, 0)
    try {
      expect(isConversationGone('halo-temp', 'c1')).toBe(false)
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('retains task state when the conversation directory cannot be traversed', () => {
    mkdirSync(join(root, 'temp'), { recursive: true })
    writeFileSync(join(root, 'temp', 'conversations'), 'not a directory')
    spaces.set('halo-temp', { id: 'halo-temp', path: join(root, 'temp'), isTemp: true })
    expect(isConversationGone('halo-temp', 'c1')).toBe(false)
  })

  it('retains task state if the directory disappears during the file check', () => {
    const dir = join(root, 'temp', 'conversations')
    mkdirSync(dir, { recursive: true })
    spaces.set('halo-temp', { id: 'halo-temp', path: join(root, 'temp'), isTemp: true })
    vi.mocked(statSync).mockImplementationOnce(() => {
      rmSync(dir, { recursive: true })
      throw Object.assign(new Error('Directory disappeared'), { code: 'ENOENT' })
    })

    expect(isConversationGone('halo-temp', 'c1')).toBe(false)
  })

  it('is false when the space folder cannot be seen (unmounted drive)', () => {
    spaces.set('s1', { id: 's1', path: join(root, 'missing-volume'), isTemp: false })

    expect(isConversationGone('s1', 'c1')).toBe(false)
  })
})
