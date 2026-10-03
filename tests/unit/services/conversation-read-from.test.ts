/**
 * What the desktop renderer reads: `getConversationFrom` (a finished turn
 * re-reads only its own messages) and `withImageFiles` (stored images go out
 * as file URLs, not base64). The service is real; its IO boundaries are an
 * in-memory disk (same harness as conversation-update-message-by-id.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => {
  const files = new Map<string, string>()
  return {
    __disk: files,
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string) => {
      const data = files.get(p)
      if (data === undefined) throw new Error(`ENOENT: ${p}`)
      return data
    },
    writeFileSync: (p: string, data: string) => {
      files.set(p, data)
    },
    mkdirSync: () => undefined,
    readdirSync: (p: string) =>
      [...files.keys()]
        .filter((k) => k.startsWith(p))
        .map((k) => k.split('/').pop() as string),
    rmSync: (p: string) => {
      files.delete(p)
    },
    renameSync: (from: string, to: string) => {
      const data = files.get(from)
      if (data === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, data)
    },
  }
})

vi.mock('../../../src/main/services/space.service', () => ({
  getSpace: (spaceId: string) => ({ id: spaceId, path: `/spaces/${spaceId}`, isTemp: false }),
  touchSpaceActivity: () => undefined,
}))
vi.mock('../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [] }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getConfig: () => undefined }))

import {
  createConversation,
  addMessage,
  getConversation,
  getConversationFrom,
  withImageFiles,
} from '../../../src/main/services/conversation.service'
import * as fs from 'fs'

const SPACE = 'space-read-from'

describe('getConversationFrom', () => {
  it('returns the messages from the given one on, marked as cut', () => {
    const conversation = createConversation(SPACE, 'T')
    addMessage(SPACE, conversation.id, { role: 'user', content: 'first' })
    addMessage(SPACE, conversation.id, { role: 'assistant', content: 'one' })
    const second = addMessage(SPACE, conversation.id, { role: 'user', content: 'second' })
    addMessage(SPACE, conversation.id, { role: 'assistant', content: 'two' })

    const read = getConversationFrom(SPACE, conversation.id, second.id)!
    expect(read.messagesFrom).toBe(second.id)
    expect(read.messages.map(m => m.content)).toEqual(['second', 'two'])
    expect(read.id).toBe(conversation.id)
  })

  it('returns the whole conversation, unmarked, for an unknown message id', () => {
    const conversation = createConversation(SPACE, 'T')
    addMessage(SPACE, conversation.id, { role: 'user', content: 'only' })
    const read = getConversationFrom(SPACE, conversation.id, 'gone')!
    expect(read.messagesFrom).toBeUndefined()
    expect(read.messages.map(m => m.content)).toEqual(['only'])
  })

  it('returns null for an unknown conversation', () => {
    expect(getConversationFrom(SPACE, 'missing', 'x')).toBeNull()
  })
})

describe('withImageFiles', () => {
  const png = Buffer.from('fake png bytes').toString('base64')
  const disk = (fs as unknown as { __disk: Map<string, unknown> }).__disk

  it('sends stored images as file URLs and writes each file once, keeping the stored data', () => {
    const conversation = createConversation(SPACE, 'T')
    addMessage(SPACE, conversation.id, {
      role: 'user',
      content: 'look',
      images: [{ id: 'img-1', type: 'image', mediaType: 'image/png', data: png }],
    })
    const stored = getConversation(SPACE, conversation.id)!

    const view = withImageFiles(SPACE, stored)
    const image = view.messages[0].images![0]
    expect(image.data).toBe('')
    expect(image.url).toMatch(/^halo-file:\/\/.*\.images\/.*img-1\.png$/)
    const filePath = decodeURIComponent(image.url!.replace('halo-file://', ''))
    expect(Buffer.from(disk.get(filePath) as Buffer).toString()).toBe('fake png bytes')

    // The stored conversation keeps its data for remote clients.
    expect(getConversation(SPACE, conversation.id)!.messages[0].images![0].data).toBe(png)
    disk.set(filePath, Buffer.from('changed'))
    withImageFiles(SPACE, stored)
    expect(Buffer.from(disk.get(filePath) as Buffer).toString()).toBe('changed')
  })

  it('returns a conversation without inline images untouched', () => {
    const conversation = createConversation(SPACE, 'T')
    addMessage(SPACE, conversation.id, { role: 'user', content: 'no images' })
    const stored = getConversation(SPACE, conversation.id)!
    expect(withImageFiles(SPACE, stored)).toBe(stored)
  })
})
