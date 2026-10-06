/**
 * Sending a file through WeCom says why it failed, in words the digital human
 * can pass on.
 *
 * A file over the platform's size limit used to be uploaded in full and then
 * refused; the platform's answer is a raw frame, which the log turned into
 * "[object Object]", and the digital human was told to check the connection.
 * Now the size is checked first, an image too big to send as one goes as a
 * file attachment, and a refusal keeps the platform's errcode and errmsg.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../../../../src/main/services/proxy-fetch', () => ({
  resolveProxyAgent: async () => undefined,
}))
vi.mock('../../../../../src/main/services/notification.service', () => ({
  notifyAppEvent: vi.fn(),
}))

interface Upload {
  bytes: number
  type: string
  filename: string
}

interface FakeWSClient {
  /** What was uploaded, by size — the files are large and a mock would keep every byte. */
  uploads: Upload[]
  /** The next upload rejects with this, as the SDK does with a failed ack. */
  uploadFailure: unknown
  sendMediaMessage: ReturnType<typeof vi.fn>
  goAuthenticated(): void
}

vi.mock('@wecom/aibot-node-sdk', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events')
  const registry: FakeWSClient[] = []

  class WSClient extends EE {
    isConnected = false
    uploads: Upload[] = []
    uploadFailure: unknown = undefined
    sendMessage = vi.fn(async () => undefined)
    replyStreamNonBlocking = vi.fn(async () => 'sent')
    replyStream = vi.fn(async () => undefined)
    reply = vi.fn(async () => undefined)
    replyMedia = vi.fn(async () => undefined)
    sendMediaMessage = vi.fn(async () => undefined)

    constructor(_opts: unknown) {
      super()
      registry.push(this as unknown as FakeWSClient)
    }

    uploadMedia(buf: Buffer, opts: { type: string; filename: string }): Promise<unknown> {
      this.uploads.push({ bytes: buf.length, type: opts.type, filename: opts.filename })
      const failure = this.uploadFailure
      this.uploadFailure = undefined
      if (failure !== undefined) return Promise.reject(failure)
      return Promise.resolve({ type: opts.type, media_id: 'media-1' })
    }

    connect(): void {}

    disconnect(): void {
      this.isConnected = false
    }

    goAuthenticated(): void {
      this.isConnected = true
      this.emit('authenticated')
    }
  }

  return { default: { WSClient }, __registry: registry }
})

import { WecomBotProvider } from '../../../../../src/main/apps/runtime/im-channels/wecom-bot.provider'
import * as sdk from '@wecom/aibot-node-sdk'
import type { SanctionedFile } from '../../../../../src/shared/types/im-channel'

const createdClients = (sdk as unknown as { __registry: FakeWSClient[] }).__registry
const MIB = 1024 * 1024

let dir: string
let instance: ReturnType<WecomBotProvider['createInstance']>
let logs: string[]

/** A file of the given size that takes no time to create (sparse). */
function fileOf(name: string, bytes: number): SanctionedFile {
  const path = join(dir, name)
  writeFileSync(path, '')
  truncateSync(path, bytes)
  return { resolvedPath: path, displayName: name } as SanctionedFile
}

async function connect(): Promise<FakeWSClient> {
  instance.start()
  await vi.waitFor(() => expect(createdClients.length).toBe(1))
  const client = createdClients[0]
  client.goAuthenticated()
  return client
}

function send(file: SanctionedFile): Promise<boolean> {
  return instance.fileCapability!.sendFile('chat-1', file, 'direct')
}

beforeEach(() => {
  createdClients.length = 0
  dir = mkdtempSync(join(tmpdir(), 'halo-wecom-send-'))
  instance = new WecomBotProvider().createInstance('inst-1', { botId: 'aib-test', secret: 'shh' })
  logs = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
  }
})

afterEach(() => {
  instance.stop()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('sending a file through WeCom', () => {
  it('refuses a file over the limit before uploading any of it, and says by how much', async () => {
    const client = await connect()

    await expect(send(fileOf('report.zip', 25 * MIB)))
      .rejects.toThrow('The file is 25.0 MB, over the 20 MB limit WeCom sets for files. Compress it or split it into smaller parts, then send again.')

    expect(client.uploads).toEqual([])
    expect(logs.join('\n')).toContain('event=send_file_too_large')
  })

  it('sends an image too big to go as one as a file attachment instead', async () => {
    const client = await connect()

    await expect(send(fileOf('scan.png', 12 * MIB))).resolves.toBe(true)

    expect(client.uploads).toEqual([{ bytes: 12 * MIB, type: 'file', filename: 'scan.png' }])
    expect(client.sendMediaMessage).toHaveBeenCalledWith('chat-1', 'file', 'media-1')
  })

  it('sends an image within its limit as an image, and refuses one over the file limit', async () => {
    const client = await connect()

    await expect(send(fileOf('photo.png', 2 * MIB))).resolves.toBe(true)
    await expect(send(fileOf('poster.png', 21 * MIB))).rejects.toThrow('over the 20 MB limit WeCom sets for files')

    expect(client.uploads).toEqual([{ bytes: 2 * MIB, type: 'image', filename: 'photo.png' }])
  })

  it('keeps the platform’s errcode and errmsg when it refuses the file', async () => {
    const client = await connect()
    client.uploadFailure = { headers: { req_id: 'r-1' }, errcode: 40009, errmsg: 'invalid media size' }

    await expect(send(fileOf('notes.pdf', 1 * MIB)))
      .rejects.toThrow('WeCom did not deliver the file: errcode 40009: invalid media size')

    const failure = logs.find(line => line.includes('event=send_file_failed')) ?? ''
    expect(failure).toContain('errcode 40009: invalid media size')
    expect(failure).not.toContain('[object Object]')
  })

  it('passes on the message of any other failure', async () => {
    const client = await connect()
    client.sendMediaMessage.mockRejectedValueOnce(new Error('Reply ack timeout'))

    await expect(send(fileOf('notes.pdf', 1 * MIB))).rejects.toThrow('WeCom did not deliver the file: Reply ack timeout')
  })

  it('still answers false while the connection is down', async () => {
    instance.start()
    await vi.waitFor(() => expect(createdClients.length).toBe(1))

    await expect(send(fileOf('notes.pdf', 1 * MIB))).resolves.toBe(false)
    expect(createdClients[0].uploads).toEqual([])
  })
})
