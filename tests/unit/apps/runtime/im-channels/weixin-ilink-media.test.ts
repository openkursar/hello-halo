/**
 * Unit tests for media handling in apps/runtime/im-channels/weixin-ilink.provider.
 *
 * Network and crypto are mocked; what is under test is the provider's own
 * behaviour around them:
 *   - a media item becomes an attachment (and an inlined image) on the InboundMessage
 *   - a failing download degrades to a text placeholder without taking down
 *     the rest of the message or the batch
 *   - the number of inlined images per message is bounded
 *   - concurrent downloads are capped, and one chat's messages stay in order
 *     while other chats proceed in parallel
 *   - stop() cancels downloads that are still in flight
 *   - sendFile refuses cleanly when no context_token has been cached yet or the
 *     file is too large, and builds the right outbound item once it can
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  ImChannelInstance,
  SanctionedFile,
} from '../../../../../src/shared/types/im-channel'
import type { InboundMessage } from '../../../../../src/shared/types/inbound-message'

const fetchJson = vi.fn()
const downloadIlinkMedia = vi.fn()
const uploadIlinkMedia = vi.fn()

vi.mock('../../../../../src/main/apps/runtime/im-channels/ilink-api', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../../src/main/apps/runtime/im-channels/ilink-api')
  >()
  return { ...actual, fetchJson: (...args: unknown[]) => fetchJson(...args) }
})

vi.mock('../../../../../src/main/apps/runtime/im-channels/ilink-media', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../../src/main/apps/runtime/im-channels/ilink-media')
  >()
  return {
    ...actual,
    downloadIlinkMedia: (...args: unknown[]) => downloadIlinkMedia(...args),
    uploadIlinkMedia: (...args: unknown[]) => uploadIlinkMedia(...args),
  }
})

const { WeixinIlinkBotProvider } = await import(
  '../../../../../src/main/apps/runtime/im-channels/weixin-ilink.provider'
)

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])

function inboundMessage(
  itemList: unknown[],
  messageId = 4242,
  fromUserId = 'user-1',
): Record<string, unknown> {
  return {
    from_user_id: fromUserId,
    message_id: messageId,
    message_type: 1,
    context_token: 'ctx-1',
    item_list: itemList,
  }
}

/** One getupdates batch, then an abort so the poll loop exits. */
function servePoll(msgs: unknown[]): void {
  let served = false
  fetchJson.mockImplementation(async (_method: string, url: string) => {
    if (url.endsWith('/ilink/bot/getupdates')) {
      if (served) throw new Error('Aborted')
      served = true
      return { get_updates_buf: 'buf-1', msgs }
    }
    return { ret: 0 }
  })
}

/** Start an instance and resolve once `count` messages have reached the handler. */
function startInstanceFor(count: number): {
  instance: ImChannelInstance
  delivered: Promise<InboundMessage[]>
} {
  const instance = new WeixinIlinkBotProvider().createInstance('inst-1', {
    botToken: 'token-abc',
    accountId: 'bot-1',
  })
  const seen: InboundMessage[] = []
  const delivered = new Promise<InboundMessage[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`only ${seen.length} of ${count} messages delivered`)),
      4000,
    )
    instance.onInbound((msg) => {
      seen.push(msg)
      if (seen.length < count) return
      clearTimeout(timer)
      resolve(seen)
    })
  })
  instance.start()
  return { instance, delivered }
}

function startInstance(): {
  instance: ImChannelInstance
  delivered: Promise<InboundMessage>
} {
  const { instance, delivered } = startInstanceFor(1)
  return { instance, delivered: delivered.then((msgs) => msgs[0]) }
}

const staged: string[] = []

beforeEach(() => {
  fetchJson.mockReset()
  downloadIlinkMedia.mockReset()
  uploadIlinkMedia.mockReset()
})

afterEach(() => {
  for (const path of staged.splice(0)) {
    try {
      unlinkSync(path)
    } catch {
      /* already gone */
    }
  }
})

describe('inbound media', () => {
  it('stages an image as an attachment and inlines it for the model', async () => {
    downloadIlinkMedia.mockResolvedValue({ data: PNG, mime: 'image/png' })
    servePoll([inboundMessage([
      { type: 1, text_item: { text: 'look at this' } },
      { type: 2, image_item: { media: { encrypt_query_param: 'q', aes_key: 'k' } } },
    ])])

    const { instance, delivered } = startInstance()
    const msg = await delivered
    instance.stop()

    expect(msg.attachments).toHaveLength(1)
    const attachment = msg.attachments![0]
    staged.push(attachment.localPath)
    expect(attachment.type).toBe('image')
    expect(attachment.mimeType).toBe('image/png')
    expect(msg.body).toBe(`look at this\n[Image: ${attachment.filename}]`)

    expect(msg.images).toHaveLength(1)
    expect(msg.images![0].mediaType).toBe('image/png')
    expect(msg.images![0].data).toBe(PNG.toString('base64'))
  })

  it('uses the wire file_name for a file item', async () => {
    downloadIlinkMedia.mockResolvedValue({ data: Buffer.from('%PDF-1.4'), mime: 'application/octet-stream' })
    servePoll([inboundMessage([
      { type: 4, file_item: { file_name: 'report.pdf', media: { encrypt_query_param: 'q' } } },
    ])])

    const { instance, delivered } = startInstance()
    const msg = await delivered
    instance.stop()

    staged.push(msg.attachments![0].localPath)
    expect(msg.attachments![0].filename).toBe('report.pdf')
    expect(msg.attachments![0].type).toBe('file')
    expect(msg.body).toBe('[File: report.pdf]')
    expect(msg.images).toBeUndefined()
  })

  it('accepts the alternate wire spelling of the file name', async () => {
    downloadIlinkMedia.mockResolvedValue({ data: Buffer.from('%PDF-1.4'), mime: 'application/octet-stream' })
    servePoll([inboundMessage([
      { type: 4, file_item: { filename: 'legacy.pdf', media: { encrypt_query_param: 'q' } } },
    ])])

    const { instance, delivered } = startInstance()
    const msg = await delivered
    instance.stop()

    staged.push(msg.attachments![0].localPath)
    expect(msg.attachments![0].filename).toBe('legacy.pdf')
    expect(msg.body).toBe('[File: legacy.pdf]')
  })

  it('attaches an oversized image without inlining it', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)])
    downloadIlinkMedia.mockResolvedValue({ data: big, mime: 'image/png' })
    servePoll([inboundMessage([
      { type: 2, image_item: { media: { encrypt_query_param: 'q', aes_key: 'k' } } },
    ])])

    const { instance, delivered } = startInstance()
    const msg = await delivered
    instance.stop()

    staged.push(msg.attachments![0].localPath)
    expect(msg.attachments).toHaveLength(1)
    expect(msg.images).toBeUndefined()
  })

  it('degrades a failed download to a placeholder and keeps the rest of the message', async () => {
    downloadIlinkMedia.mockRejectedValue(new Error('PKCS7 unpad failed'))
    servePoll([inboundMessage([
      { type: 4, file_item: { file_name: 'report.pdf', media: { encrypt_query_param: 'q' } } },
      { type: 1, text_item: { text: 'did you get it?' } },
    ])])

    const { instance, delivered } = startInstance()
    const msg = await delivered
    instance.stop()

    expect(msg.body).toBe('[File: report.pdf — download failed]\ndid you get it?')
    expect(msg.attachments).toBeUndefined()
    expect(msg.images).toBeUndefined()
  })

  it('keeps handling the batch when the inbound handler throws', async () => {
    servePoll([
      inboundMessage([{ type: 1, text_item: { text: 'boom' } }], 4242),
      inboundMessage([{ type: 1, text_item: { text: 'still here' } }], 4243),
    ])

    const instance = new WeixinIlinkBotProvider().createInstance('inst-1', {
      botToken: 'token-abc',
      accountId: 'bot-1',
    })
    const seen: string[] = []
    const delivered = new Promise<InboundMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no inbound message delivered')), 2000)
      instance.onInbound((msg) => {
        seen.push(msg.body)
        if (msg.body === 'boom') throw new Error('handler exploded')
        clearTimeout(timer)
        resolve(msg)
      })
    })
    instance.start()

    const msg = await delivered
    instance.stop()

    expect(seen).toEqual(['boom', 'still here'])
    expect(msg.body).toBe('still here')
  })

  it('cancels an in-flight download when the instance stops', async () => {
    downloadIlinkMedia.mockResolvedValue({ data: PNG, mime: 'image/png' })
    servePoll([inboundMessage([
      { type: 2, image_item: { media: { encrypt_query_param: 'q', aes_key: 'k' } } },
    ])])

    const { instance, delivered } = startInstance()
    const msg = await delivered
    staged.push(msg.attachments![0].localPath)

    const signal = downloadIlinkMedia.mock.calls[0][2] as AbortSignal
    expect(signal.aborted).toBe(false)
    instance.stop()
    expect(signal.aborted).toBe(true)
  })

  it('bounds how many images one message can inline', async () => {
    downloadIlinkMedia.mockResolvedValue({ data: PNG, mime: 'image/png' })
    const imageItem = { type: 2, image_item: { media: { encrypt_query_param: 'q', aes_key: 'k' } } }
    servePoll([inboundMessage(Array.from({ length: 6 }, () => imageItem))])

    const { instance, delivered } = startInstance()
    const msg = await delivered
    instance.stop()

    for (const attachment of msg.attachments!) staged.push(attachment.localPath)
    // Every image is still staged as a file; only the inlining is capped.
    expect(msg.attachments).toHaveLength(6)
    expect(msg.images).toHaveLength(4)
  })

  it('attaches an image it could not type without inlining it', async () => {
    const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(16, 0x07)])
    downloadIlinkMedia.mockResolvedValue({ data: bmp, mime: 'application/octet-stream' })
    servePoll([inboundMessage([
      { type: 2, image_item: { media: { encrypt_query_param: 'q', aes_key: 'k' } } },
    ])])

    const { instance, delivered } = startInstance()
    const msg = await delivered
    instance.stop()

    const attachment = msg.attachments![0]
    staged.push(attachment.localPath)
    expect(attachment.type).toBe('image')
    expect(attachment.mimeType).toBe('application/octet-stream')
    // Not `.octet-stream` — an untypeable image gets a neutral extension.
    expect(attachment.filename).toMatch(/^image_\d+\.bin$/)
    expect(msg.images).toBeUndefined()
  })

  it('reports an unresolved media handle without dropping the item', async () => {
    servePoll([inboundMessage([{ type: 2 }])])

    const { instance, delivered } = startInstance()
    const msg = await delivered
    instance.stop()

    expect(msg.body).toBe('[Image]')
    expect(downloadIlinkMedia).not.toHaveBeenCalled()
  })
})

describe('inbound dispatch', () => {
  const imageItem = { type: 2, image_item: { media: { encrypt_query_param: 'q', aes_key: 'k' } } }

  /** A download that stays in flight long enough for overlap to be observable. */
  function slowDownload(onStart: () => void, onEnd: () => void): void {
    downloadIlinkMedia.mockImplementation(async () => {
      onStart()
      await new Promise((resolve) => setTimeout(resolve, 20))
      onEnd()
      return { data: PNG, mime: 'image/png' }
    })
  }

  it('caps how many downloads a batch can run at once', async () => {
    let inFlight = 0
    let peak = 0
    slowDownload(
      () => { peak = Math.max(peak, ++inFlight) },
      () => { inFlight-- },
    )
    // One image each, from distinct chats — per-chat ordering imposes no bound here.
    servePoll(Array.from({ length: 6 }, (_, i) =>
      inboundMessage([imageItem], 5000 + i, `user-${i}`),
    ))

    const { instance, delivered } = startInstanceFor(6)
    const msgs = await delivered
    instance.stop()

    for (const msg of msgs) staged.push(msg.attachments![0].localPath)
    expect(peak).toBe(3)
  })

  it('keeps one chat in order while other chats proceed in parallel', async () => {
    slowDownload(() => {}, () => {})
    servePoll([
      inboundMessage([imageItem], 6001, 'user-1'),
      inboundMessage([{ type: 1, text_item: { text: 'and this' } }], 6002, 'user-1'),
      inboundMessage([{ type: 1, text_item: { text: 'unrelated chat' } }], 6003, 'user-2'),
    ])

    const { instance, delivered } = startInstanceFor(3)
    const msgs = await delivered
    instance.stop()

    staged.push(msgs.find((m) => m.attachments)!.attachments![0].localPath)
    // The other chat is not held up by the download, and user-1's follow-up
    // still lands behind the image it was sent after.
    expect(msgs.map((m) => m.chatId)).toEqual(['user-2', 'user-1', 'user-1'])
    expect(msgs[1].attachments).toHaveLength(1)
    expect(msgs[2].body).toBe('and this')
  })
})

describe('outbound sendFile', () => {
  const file = {
    resolvedPath: '/tmp/does-not-exist.pdf',
    displayName: 'quarterly.pdf',
  } as unknown as SanctionedFile

  it('refuses without a cached context_token instead of throwing', async () => {
    fetchJson.mockImplementation(async () => {
      throw new Error('Aborted')
    })
    const instance = new WeixinIlinkBotProvider().createInstance('inst-1', {
      botToken: 'token-abc',
      accountId: 'bot-1',
    })

    await expect(instance.fileCapability!.sendFile('user-1', file, 'direct')).resolves.toBe(false)
    expect(uploadIlinkMedia).not.toHaveBeenCalled()
  })

  it('uploads and sends a file item once a context_token has been cached', async () => {
    downloadIlinkMedia.mockResolvedValue({ data: PNG, mime: 'image/png' })
    uploadIlinkMedia.mockResolvedValue({
      media: { encrypt_query_param: 'p', aes_key: 'k', encrypt_type: 1 },
      ciphertextSize: 32,
    })
    servePoll([inboundMessage([{ type: 1, text_item: { text: 'hi' } }])])

    const { instance, delivered } = startInstance()
    await delivered

    const { writeFile } = await import('fs/promises')
    const tmpFile = join(tmpdir(), 'halo-ilink-send-test.pdf')
    await writeFile(tmpFile, 'payload')
    staged.push(tmpFile)

    const sent = await instance.fileCapability!.sendFile(
      'user-1',
      { ...file, resolvedPath: tmpFile } as unknown as SanctionedFile,
      'direct',
    )
    instance.stop()
    expect(sent).toBe(true)

    const sendCall = fetchJson.mock.calls.find(
      (call) => typeof call[1] === 'string' && call[1].endsWith('/ilink/bot/sendmessage'),
    )
    expect(sendCall).toBeDefined()
    const body = sendCall![3] as { msg: { context_token: string; item_list: unknown[] } }
    expect(body.msg.context_token).toBe('ctx-1')
    expect(body.msg.item_list).toEqual([
      {
        type: 4,
        file_item: {
          media: { encrypt_query_param: 'p', aes_key: 'k', encrypt_type: 1 },
          file_name: 'quarterly.pdf',
          // The raw size — what WeChat shows the recipient as their file's size.
          file_size: 'payload'.length,
        },
      },
    ])
    expect(uploadIlinkMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'file', toUserId: 'user-1' }),
    )
  })

  it('decides image-vs-file from the name the recipient will see', async () => {
    uploadIlinkMedia.mockResolvedValue({
      media: { encrypt_query_param: 'p', aes_key: 'k', encrypt_type: 1 },
      ciphertextSize: 32,
    })
    servePoll([inboundMessage([{ type: 1, text_item: { text: 'hi' } }])])

    const { instance, delivered } = startInstance()
    await delivered

    const { writeFile } = await import('fs/promises')
    // Extensionless on disk, but presented to the user as a PNG.
    const tmpFile = join(tmpdir(), 'halo-ilink-send-test-blob')
    await writeFile(tmpFile, 'payload')
    staged.push(tmpFile)

    await instance.fileCapability!.sendFile(
      'user-1',
      { resolvedPath: tmpFile, displayName: 'chart.png' } as unknown as SanctionedFile,
      'direct',
    )
    instance.stop()

    expect(uploadIlinkMedia).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image' }))
    const sendCall = fetchJson.mock.calls.find(
      (call) => typeof call[1] === 'string' && call[1].endsWith('/ilink/bot/sendmessage'),
    )
    const body = sendCall![3] as { msg: { item_list: Array<{ type: number }> } }
    expect(body.msg.item_list[0].type).toBe(2)
  })

  it('refuses an oversized file before reading it into memory', async () => {
    servePoll([inboundMessage([{ type: 1, text_item: { text: 'hi' } }])])

    const { instance, delivered } = startInstance()
    await delivered

    const { writeFile } = await import('fs/promises')
    const tmpFile = join(tmpdir(), 'halo-ilink-send-test-big.bin')
    await writeFile(tmpFile, Buffer.alloc(26 * 1024 * 1024))
    staged.push(tmpFile)

    const sent = await instance.fileCapability!.sendFile(
      'user-1',
      { resolvedPath: tmpFile, displayName: 'big.bin' } as unknown as SanctionedFile,
      'direct',
    )
    instance.stop()

    expect(sent).toBe(false)
    expect(uploadIlinkMedia).not.toHaveBeenCalled()
  })
})
