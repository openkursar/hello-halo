/**
 * Tool-result images leave Halo's display copy as files.
 *
 * The engine's own message is never touched; the display copy (Thought output,
 * transcript line) refers to a file written once by content. A folder that
 * cannot be written keeps the image inline, as before.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({ analytics: { track: vi.fn() } }))
vi.mock('../../../../src/main/services/agent/mcp-manager', () => ({ broadcastMcpStatus: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-probe', () => ({ probeUnhealthyServers: vi.fn() }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../../../src/main/foundation/logging', () => ({ isDeveloperMode: () => false }))

import {
  contentAddressedImageName,
  hasInlineToolImages,
  toolResultDisplayText,
  withImageFiles,
  withToolResultImageFiles,
} from '../../../../src/main/services/agent/tool-result-images'
import { parseSDKMessage } from '../../../../src/main/services/agent/message-utils'
import { handleToolMessage } from '../../../../src/main/services/agent/tool-message-handler'
import {
  copySessionJsonl,
  deleteRunTranscript,
  deleteTranscriptImages,
  openSessionWriter,
  readSessionMessages,
  readSessionUpdate,
  transcriptImagesDir,
} from '../../../../src/main/apps/runtime/session-store'
import { processStream } from '../../../../src/main/services/agent/stream-processor'
import { readToolOutputImages } from '../../../../src/shared/tool-result-images'
import type { Thought } from '../../../../src/main/services/agent/types'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c40000000049454e44ae426082', 'hex')
const base64 = PNG.toString('base64')
const anthropicImage = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } })
const mcpImage = () => ({ type: 'image', data: base64, mimeType: 'image/png' })
const toolResultMessage = (content: unknown, id = 'tu-1') => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'halo-tool-images-'))
  emitAgentEvent.mockClear()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('withImageFiles', () => {
  it('writes each image once by content and refers to it, in either block shape', () => {
    const imagesDir = join(dir, 'images')
    const content = [{ type: 'text', text: 'screenshot' }, anthropicImage(), mcpImage()]
    const result = withImageFiles(content, imagesDir) as Array<Record<string, unknown>>
    const name = contentAddressedImageName(base64, 'image/png')
    expect(result).toEqual([
      { type: 'text', text: 'screenshot' },
      { type: 'image_file', path: join(imagesDir, name), media_type: 'image/png', bytes: PNG.length },
      { type: 'image_file', path: join(imagesDir, name), media_type: 'image/png', bytes: PNG.length },
    ])
    expect(readdirSync(imagesDir)).toEqual([name])
    expect(readFileSync(join(imagesDir, name))).toEqual(PNG)
  })

  it('never changes the content it was given', () => {
    const content = [anthropicImage()]
    const before = JSON.stringify(content)
    withImageFiles(content, join(dir, 'images'))
    expect(JSON.stringify(content)).toBe(before)
  })

  it('returns the same value when there is no image', () => {
    const content = [{ type: 'text', text: 'plain' }]
    expect(withImageFiles(content, dir)).toBe(content)
    expect(withImageFiles('text', dir)).toBe('text')
  })

  it('keeps the image inline when its folder cannot be written', () => {
    const blocked = join(dir, 'file')
    writeFileSync(blocked, 'not a folder')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const content = [anthropicImage()]
    expect(withImageFiles(content, join(blocked, 'images'))).toBe(content)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('names files by content: 16 hex characters and the image extension', () => {
    expect(contentAddressedImageName(base64, 'image/png')).toMatch(/^[0-9a-f]{16}\.png$/)
    expect(contentAddressedImageName(base64, 'image/jpeg')).toMatch(/\.jpg$/)
  })
})

describe('display text', () => {
  /** Images are saved beside the record they belong to, in a `.images` folder. */
  const saveTo = () => join(dir, 'conv.images')

  it('keeps text and JSON as before without a folder', () => {
    expect(toolResultDisplayText('plain')).toBe('plain')
    expect(toolResultDisplayText([anthropicImage()])).toBe(JSON.stringify([anthropicImage()]))
  })

  it('is JSON whose images are file references with a folder, read back by the shared reader', () => {
    const output = toolResultDisplayText([{ type: 'text', text: 'caption' }, anthropicImage()], saveTo())
    expect(output).not.toContain(base64)
    const parts = readToolOutputImages(output)!
    expect(parts[0]).toEqual({ type: 'text', text: 'caption' })
    expect(parts[1]).toMatchObject({ type: 'image_file', media_type: 'image/png', bytes: PNG.length })
    expect(existsSync((parts[1] as { path: string }).path)).toBe(true)
  })

  it('parseSDKMessage gives the display copy file references only when told where to save', () => {
    const message = toolResultMessage([anthropicImage()])
    const before = JSON.stringify(message)
    const inline = parseSDKMessage(message)!
    expect(inline.toolOutput).toBe(JSON.stringify([anthropicImage()]))
    const saved = parseSDKMessage(message, undefined, saveTo())!
    expect(readToolOutputImages(saved.toolOutput!)).toHaveLength(1)
    expect(JSON.stringify(message)).toBe(before)
  })

  it('sub-agent tool results get file references too', () => {
    const thoughts: Thought[] = [{ id: 'th-1', type: 'tool_use', content: '', timestamp: '', toolName: 'Read' }]
    handleToolMessage(toolResultMessage([anthropicImage()], 'tu-9'), 'parent', {
      spaceId: 's', conversationId: 'c', sessionState: { thoughts } as never,
      toolIdToThoughtId: new Map([['tu-9', 'th-1']]), toolImagesDir: saveTo(),
    })
    expect(readToolOutputImages(thoughts[0].toolResult!.output)).toHaveLength(1)
  })
})

describe('transcript lines', () => {
  const runs = () => join(dir, '.halo', 'apps', 'app-1', 'runs')
  const name = contentAddressedImageName(base64, 'image/png')

  function writeRun(runId: string) {
    const writer = openSessionWriter(dir, 'app-1', runId)
    writer.writeTrigger('look', [])
    writer.writeEvent({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/x/a.png' } }] } })
    writer.writeEvent(toolResultMessage([anthropicImage()]))
    writer.writeEvent({ type: 'result', result: 'seen' })
  }

  /** The saved image paths the read transcript's steps refer to. */
  function imagePaths(runId: string): string[] {
    return readSessionMessages(dir, 'app-1', runId).flatMap(message => (message.thoughts ?? [])
      .flatMap(thought => readToolOutputImages(thought.toolResult?.output ?? '') ?? [])
      .flatMap(part => part.type === 'image_file' ? [part.path] : []))
  }

  it('tells whether a message carries an inline tool image', () => {
    expect(hasInlineToolImages(toolResultMessage([anthropicImage()]))).toBe(true)
    expect(hasInlineToolImages(toolResultMessage('text'))).toBe(false)
    expect(hasInlineToolImages({ type: 'assistant', message: { content: [anthropicImage()] } })).toBe(false)
  })

  it('copies only a message whose tool results carry images', () => {
    const plain = toolResultMessage('text')
    expect(withToolResultImageFiles(plain, dir)).toBe(plain)
    const withImage = toolResultMessage([anthropicImage()])
    const before = JSON.stringify(withImage)
    const stored = withToolResultImageFiles(withImage, dir)
    expect(stored).not.toBe(withImage)
    expect(JSON.stringify(stored)).not.toContain(base64)
    expect(JSON.stringify(withImage)).toBe(before)
  })

  it('a transcript keeps its images beside itself and shows them in the step; older lines read as before', () => {
    writeRun('run-1')
    const line = readFileSync(join(runs(), 'run-1.jsonl'), 'utf8')
    expect(line).not.toContain(base64)
    expect(transcriptImagesDir(dir, 'app-1', 'run-1')).toBe(join(runs(), 'run-1.images'))
    expect(readdirSync(join(runs(), 'run-1.images'))).toEqual([name])
    expect(existsSync(join(dir, '.halo', 'attachments'))).toBe(false)
    expect(imagePaths('run-1')).toEqual([join(runs(), 'run-1.images', name)])

    writeFileSync(join(runs(), 'run-2.jsonl'), [
      { _ts: new Date().toISOString(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-2', name: 'Read', input: {} }] } },
      { _ts: new Date().toISOString(), ...toolResultMessage([{ type: 'text', text: 'old caption' }, anthropicImage()], 'tu-2') },
    ].map(event => JSON.stringify(event)).join('\n') + '\n')
    const [old] = readSessionMessages(dir, 'app-1', 'run-2')[0].thoughts!
    expect(old.toolResult!.output).toBe('old caption')
  })

  it('a transcript without images gets no images folder', () => {
    const writer = openSessionWriter(dir, 'app-1', 'plain')
    writer.writeTrigger('hello', [])
    writer.writeEvent(toolResultMessage('text only'))
    expect(existsSync(join(runs(), 'plain.jsonl'))).toBe(true)
    expect(existsSync(join(runs(), 'plain.images'))).toBe(false)
  })

  it('deleting a run removes its images; clearing a chat removes them too', () => {
    writeRun('run-1')
    writeRun('chat')
    deleteRunTranscript(dir, 'app-1', 'run-1')
    expect(existsSync(join(runs(), 'run-1.jsonl'))).toBe(false)
    expect(existsSync(join(runs(), 'run-1.images'))).toBe(false)
    expect(existsSync(join(runs(), 'chat.images', name))).toBe(true)
    deleteTranscriptImages(dir, 'app-1', 'chat')
    expect(existsSync(join(runs(), 'chat.images'))).toBe(false)
  })

  it('clearing reports images it could not remove', () => {
    writeRun('chat')
    chmodSync(runs(), 0o500)
    try {
      expect(() => deleteTranscriptImages(dir, 'app-1', 'chat')).toThrow()
    } finally {
      chmodSync(runs(), 0o700)
    }
    expect(existsSync(join(runs(), 'chat.images'))).toBe(true)
  })

  it('a copy shares the saved files instead of copying their bytes', () => {
    writeRun('chat')
    expect(copySessionJsonl(dir, 'app-1', 'chat', 'chat-fork')).toBe(true)
    expect(statSync(join(runs(), 'chat-fork.images', name)).ino).toBe(statSync(join(runs(), 'chat.images', name)).ino)
  })

  it('a copied chat shows its images from its own copy, also once the original is gone', () => {
    writeRun('chat')
    expect(copySessionJsonl(dir, 'app-1', 'chat', 'chat-fork')).toBe(true)
    expect(imagePaths('chat-fork')).toEqual([join(runs(), 'chat-fork.images', name)])
    deleteRunTranscript(dir, 'app-1', 'chat')
    expect(readFileSync(imagePaths('chat-fork')[0])).toEqual(PNG)
  })

  it('a transcript moved with its folder refers to the images where they now are', () => {
    writeRun('run-1')
    const moved = mkdtempSync(join(tmpdir(), 'halo-tool-images-moved-'))
    try {
      renameSync(join(dir, '.halo'), join(moved, '.halo'))
      const paths = readSessionMessages(moved, 'app-1', 'run-1').flatMap(message => (message.thoughts ?? [])
        .flatMap(thought => readToolOutputImages(thought.toolResult?.output ?? '') ?? [])
        .flatMap(part => part.type === 'image_file' ? [part.path] : []))
      expect(paths).toEqual([join(moved, '.halo', 'apps', 'app-1', 'runs', 'run-1.images', name)])
      expect(readFileSync(paths[0])).toEqual(PNG)
      const update = readSessionUpdate(moved, 'app-1', 'run-1', '')
      expect(JSON.stringify(update)).toContain(join(moved, '.halo', 'apps', 'app-1', 'runs', 'run-1.images', name).replace(/\\/g, '\\\\'))
    } finally {
      rmSync(moved, { recursive: true, force: true })
    }
  })

  it('a stopped turn\'s checkpoint refers to its images where the transcript now is', () => {
    const writer = openSessionWriter(dir, 'app-1', 'stopped')
    writer.writeTrigger('look', [])
    const old = JSON.stringify([{ type: 'image_file', path: `/elsewhere/stopped.images/${name}`, media_type: 'image/png', bytes: PNG.length }])
    writer.writeEvent({ type: 'turn_snapshot', content: 'partial', thoughts: [
      { id: 's-1', type: 'tool_use', content: '', timestamp: 't', toolName: 'Read', toolResult: { output: old, isError: false, timestamp: 't' } },
      // A result whose call was not seen is kept as a step of its own.
      { id: 's-2', type: 'tool_result', content: 'Tool execution succeeded', timestamp: 't', toolOutput: old },
    ] })
    const [, reply] = readSessionMessages(dir, 'app-1', 'stopped')
    expect(readToolOutputImages(reply.thoughts![0].toolResult!.output)).toEqual([
      expect.objectContaining({ path: join(runs(), 'stopped.images', name) }),
    ])
    expect(readToolOutputImages(reply.thoughts![1].toolOutput!)).toEqual([
      expect.objectContaining({ path: join(runs(), 'stopped.images', name) }),
    ])
  })

  it('the step on screen and the stored line refer to one file when the entry names the folder', async () => {
    const folder = transcriptImagesDir(dir, 'app-1', 'chat')
    const message = toolResultMessage([anthropicImage()], 'tu-live')
    const state = { thoughts: [] as Thought[] } as never
    await processStream({
      v2Session: { send: vi.fn(), stream: () => (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [] }
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu-live', name: 'Read', input: {} } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } } }
        yield { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }
        yield message
        yield { type: 'result', subtype: 'success', result: 'done', is_error: false }
      })() },
      sessionState: state, spaceId: 'space-1', conversationId: 'app-chat:app-1', displayModel: 'm',
      abortController: new AbortController(), t0: Date.now(), callbacks: {}, toolImagesDir: () => folder,
    })
    const live = (state as { thoughts: Thought[] }).thoughts.find(thought => thought.toolName === 'Read')!
    expect(readToolOutputImages(live.toolResult!.output)).toEqual([expect.objectContaining({ path: join(folder, name) })])
    const writer = openSessionWriter(dir, 'app-1', 'chat')
    writer.writeEvent(message)
    expect(readFileSync(join(runs(), 'chat.jsonl'), 'utf8')).toContain(JSON.stringify(join(folder, name)))
  })

  it('a digital human stream without a named folder keeps its images inline', async () => {
    const state = { thoughts: [] as Thought[] } as never
    await processStream({
      v2Session: { send: vi.fn(), stream: () => (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [] }
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu-inline', name: 'Read', input: {} } } }
        yield { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }
        yield toolResultMessage([anthropicImage()], 'tu-inline')
        yield { type: 'result', subtype: 'success', result: 'done', is_error: false }
      })() },
      sessionState: state, spaceId: 'space-1', conversationId: 'app-chat:app-1', displayModel: 'm',
      abortController: new AbortController(), t0: Date.now(), callbacks: {},
    })
    const live = (state as { thoughts: Thought[] }).thoughts.find(thought => thought.toolName === 'Read')!
    expect(live.toolResult!.output).toContain(base64)
  })
})

describe('readToolOutputImages', () => {
  it('reads only outputs that refer to saved images', () => {
    expect(readToolOutputImages('plain text')).toBeNull()
    expect(readToolOutputImages(JSON.stringify([anthropicImage()]))).toBeNull()
    expect(readToolOutputImages('[{"type":"image_file"')).toBeNull()
    expect(readToolOutputImages(JSON.stringify([{ type: 'image_file', path: '', media_type: 'image/png', bytes: 1 }]))).toBeNull()
    // Only files Halo saved (content-hash names) with an image type count; anything else stays text.
    expect(readToolOutputImages(JSON.stringify([{ type: 'image_file', path: '/home/me/.ssh/id_rsa', media_type: 'image/png', bytes: 1 }]))).toBeNull()
    expect(readToolOutputImages(JSON.stringify([{ type: 'image_file', path: '/a/c.images/0123456789abcdef.png', media_type: 'text/plain', bytes: 1 }]))).toBeNull()
    // A content-hash name outside a `.images` folder is not one Halo saved.
    expect(readToolOutputImages(JSON.stringify([{ type: 'image_file', path: '/a/0123456789abcdef.png', media_type: 'image/png', bytes: 1 }]))).toBeNull()
    expect(readToolOutputImages(JSON.stringify([{ type: 'image_file', path: '/a/c.images/0123456789abcdef.png', media_type: 'image/png', bytes: 3 }, { type: 'other', x: 1 }]))).toEqual([
      { type: 'image_file', path: '/a/c.images/0123456789abcdef.png', media_type: 'image/png', bytes: 3 },
      { type: 'text', text: '{"type":"other","x":1}' },
    ])
  })
})
