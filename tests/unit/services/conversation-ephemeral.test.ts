/**
 * Ephemeral conversations back a view that shows its own transcript (the
 * knowledge base chat): readable by that view, left out of every conversation
 * list, and the ones a previous run left behind are deleted at startup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const env = vi.hoisted(() => ({
  root: '',
  touched: [] as string[],
}))

vi.mock('../../../src/main/services/space.service', () => {
  const space = (id: string) => (id === 'halo-temp'
    ? { id, path: `${env.root}/temp`, isTemp: true }
    : { id, path: `${env.root}/spaces/${id}`, isTemp: false })
  return {
    getSpace: (id: string) => (['halo-temp', 'space-1'].includes(id) ? space(id) : null),
    getHaloSpace: () => space('halo-temp'),
    listSpaces: () => [space('space-1')],
    touchSpaceActivity: (id: string) => { env.touched.push(id) },
  }
})
vi.mock('../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [] }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getConfig: () => undefined }))

import {
  createConversation,
  getConversation,
  listConversations,
  addMessage,
  deleteEphemeralConversations,
  flushAllPendingIndexWrites,
} from '../../../src/main/services/conversation.service'

const conversationFile = (dir: string, id: string) => join(env.root, dir, `${id}.json`)

beforeEach(() => {
  env.root = mkdtempSync(join(tmpdir(), 'halo-ephemeral-'))
  env.touched = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  flushAllPendingIndexWrites()
  // An index first written in the background (no index yet) lands on the next turn.
  await new Promise(resolve => setImmediate(resolve))
  rmSync(env.root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('an ephemeral conversation', () => {
  it('is read like any other but left out of the space list', () => {
    const own = createConversation('halo-temp', 'Mine')
    listConversations('halo-temp')
    const backing = createConversation('halo-temp', 'Ask: Docs', undefined, { ephemeral: true })
    addMessage('halo-temp', backing.id, { role: 'user', content: 'What is the refund policy?' })
    flushAllPendingIndexWrites()

    expect(getConversation('halo-temp', backing.id)?.messages[0].content).toBe('What is the refund policy?')
    expect(listConversations('halo-temp').map(c => c.id)).toEqual([own.id])
  })

  it('stays out of the list when the list is built from the files', () => {
    const own = createConversation('halo-temp', 'Mine')
    createConversation('halo-temp', 'Ask: Docs', undefined, { ephemeral: true })

    expect(listConversations('halo-temp').map(c => c.id)).toEqual([own.id])
  })

  it('does not count as activity in its space', () => {
    const backing = createConversation('halo-temp', 'Ask: Docs', undefined, { ephemeral: true })
    addMessage('halo-temp', backing.id, { role: 'user', content: 'question' })

    expect(env.touched).toEqual([])
  })
})

describe('deleteEphemeralConversations', () => {
  it('deletes the ephemeral conversations created before the cutoff, in every space, and nothing else', () => {
    const leftover = createConversation('halo-temp', 'Ask: Docs', undefined, { ephemeral: true })
    const elsewhere = createConversation('space-1', 'Ask: Other', undefined, { ephemeral: true })
    const own = createConversation('halo-temp', 'Mine')
    const cutoff = Date.now() + 1
    vi.useFakeTimers({ now: cutoff + 1000, toFake: ['Date'] })
    const inUse = createConversation('halo-temp', 'Ask: Docs', undefined, { ephemeral: true })
    vi.useRealTimers()
    // Each space's index exists once its list has been read.
    listConversations('halo-temp')
    listConversations('space-1')

    expect(deleteEphemeralConversations(cutoff)).toBe(2)

    expect(existsSync(conversationFile('temp/conversations', leftover.id))).toBe(false)
    expect(existsSync(conversationFile('spaces/space-1/.halo/conversations', elsewhere.id))).toBe(false)
    expect(getConversation('halo-temp', own.id)).not.toBeNull()
    expect(getConversation('halo-temp', inUse.id)).not.toBeNull()
    expect(listConversations('halo-temp').map(c => c.id)).toEqual([own.id])
  })

  it('leaves a space without a conversation index alone', () => {
    expect(deleteEphemeralConversations(Date.now())).toBe(0)
  })
})
