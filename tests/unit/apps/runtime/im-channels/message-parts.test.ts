/**
 * Unit tests for apps/runtime/im-channels/message-parts — how a long message is
 * cut into parts that each fit one platform message.
 *
 * What the channels rely on: nothing is lost or duplicated, every part fits
 * the limit with its `(i/n)` label, a cut never lands inside a character, it
 * prefers a paragraph or line break, a code block cut in two still renders as
 * code on both sides, and parts go out one after another.
 */

import { describe, it, expect } from 'vitest'
import {
  MAX_PARTS,
  messageHead,
  sendAsMessages,
  sendAsMessagesOrThrow,
  splitIntoMessages,
} from '../../../../../src/main/apps/runtime/im-channels/message-parts'

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/** The bodies of labeled parts, in order. */
function bodies(parts: string[]): string[] {
  return parts.map((part, i) => {
    const label = `(${i + 1}/${parts.length})\n\n`
    expect(part.startsWith(label)).toBe(true)
    return part.slice(label.length)
  })
}

describe('splitIntoMessages', () => {
  it('leaves a message that fits alone, unlabeled', () => {
    expect(splitIntoMessages('short answer', { maxBytes: 20000 })).toEqual(['short answer'])
    expect(splitIntoMessages('', { maxBytes: 20000 })).toEqual([''])
  })

  it('cuts a long message into labeled parts that each fit, losing and repeating nothing', () => {
    const text = Array.from({ length: 45000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')

    const parts = splitIntoMessages(text, { maxBytes: 20000 })

    expect(parts).toHaveLength(3)
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(20000)
    expect(bodies(parts).join('')).toBe(text)
  })

  it('never cuts inside a character', () => {
    const accented = 'é'.repeat(10001)
    expect(bodies(splitIntoMessages(accented, { maxBytes: 20000 })).join('')).toBe(accented)

    // Astral characters are two UTF-16 units: a cut between them would leave
    // a lone surrogate the platform rejects or shows as garbage.
    const emoji = '😀'.repeat(3000)
    const parts = splitIntoMessages(emoji, { maxChars: 3500 })
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(3500)
      expect(part).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    }
    expect(bodies(parts).join('')).toBe(emoji)
  })

  it('keeps every part within both limits when a platform sets both', () => {
    const text = '中文与 English 混排的一行内容。\n'.repeat(800)
    const parts = splitIntoMessages(text, { maxBytes: 6000, maxChars: 3500 })

    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(3500)
      expect(bytes(part)).toBeLessThanOrEqual(6000)
    }
    expect(bodies(parts).join('')).toBe(text)
  })

  it('ends a part at a paragraph break near the limit, else at a line break', () => {
    const paragraph = `${'word '.repeat(150).trim()}\n${'more '.repeat(150).trim()}`
    const text = Array.from({ length: 12 }, () => paragraph).join('\n\n')

    const parts = bodies(splitIntoMessages(text, { maxBytes: 4000 }))

    for (const part of parts.slice(0, -1)) expect(part.endsWith('\n')).toBe(true)
    expect(parts.join('')).toBe(text)
  })

  it('ends a part at a space rather than inside a word when a line runs past the limit', () => {
    const text = 'alpha beta gamma delta '.repeat(1000)

    const parts = bodies(splitIntoMessages(text, { maxBytes: 4000 }))

    for (const part of parts.slice(0, -1)) expect(part.endsWith(' ')).toBe(true)
    expect(parts.join('')).toBe(text)
  })

  it('closes a code block a cut lands in and reopens it in the next part', () => {
    const code = Array.from({ length: 400 }, (_, i) => `const value${i} = compute(${i})`).join('\n')
    const text = `Here is the module:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nThat is all.`

    const parts = bodies(splitIntoMessages(text, { maxBytes: 4000 }))

    expect(parts.length).toBeGreaterThan(2)
    for (const part of parts) {
      expect(bytes(part)).toBeLessThanOrEqual(4000)
      // Balanced: every part opens what it closes, so each renders on its own.
      expect((part.match(/^```/gm) ?? []).length % 2).toBe(0)
    }
    for (const part of parts.slice(1)) expect(part.startsWith('```ts\n')).toBe(true)
    // Each cut lands after a line, so the closing fence goes on a line of its own.
    for (const part of parts.slice(0, -1)) expect(part.endsWith('\n```')).toBe(true)
    // Dropping the fences the cuts added gives back the original exactly.
    const rejoined = parts
      .map((part, i) => {
        let body = part
        if (i > 0) body = body.slice('```ts\n'.length)
        if (i < parts.length - 1) body = body.slice(0, -'```'.length)
        return body
      })
      .join('')
    expect(rejoined).toBe(text)
  })

  it('always makes progress, even with a limit too small to be useful', () => {
    const parts = splitIntoMessages('x'.repeat(100), { maxChars: 30 })

    expect(parts.length).toBeGreaterThan(1)
    expect(parts.length).toBeLessThanOrEqual(MAX_PARTS)
  })

  it(`sends at most ${MAX_PARTS} parts, the last saying where to read the rest`, () => {
    const text = '一段很长的内容。\n'.repeat(4000)

    const parts = splitIntoMessages(text, { maxBytes: 4000 })

    expect(parts).toHaveLength(MAX_PARTS)
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(4000)
    const sent = bodies(parts)
    expect(sent[MAX_PARTS - 1].endsWith('（内容过长，其余部分请在 Halo 里查看）')).toBe(true)
    const shown = sent.join('').replace('\n\n（内容过长，其余部分请在 Halo 里查看）', '')
    expect(text.startsWith(shown)).toBe(true)
  })

  it('sends no part that is only whitespace', () => {
    const text = `${'a'.repeat(3990)}\n${' '.repeat(20)}\n\n   `

    const parts = splitIntoMessages(text, { maxBytes: 4000 })

    for (const body of bodies(parts)) expect(body.trim()).not.toBe('')
  })

  it('treats ~~~ and longer fences as code blocks too, closing each with its own run', () => {
    const code = Array.from({ length: 300 }, (_, i) => `step ${i}: run the task`).join('\n')
    const text = `Notes:\n\n~~~text\n${code}\n~~~\n\n\`\`\`\`md\n\`\`\`js\nnested()\n\`\`\`\n\`\`\`\`\n`

    const parts = bodies(splitIntoMessages(text, { maxBytes: 3000 }))

    expect(parts.length).toBeGreaterThan(2)
    for (const part of parts.slice(1, -1)) {
      expect(part.startsWith('~~~text\n')).toBe(true)
      expect(part.endsWith('\n~~~')).toBe(true)
    }
  })

  it('does not take ```inline``` code for the start of a block', () => {
    const text = `Use \`\`\`npm test\`\`\` to check.\n${'plain line of prose\n'.repeat(400)}`

    const parts = bodies(splitIntoMessages(text, { maxBytes: 3000 }))

    for (const part of parts) expect(part).not.toMatch(/^```$/m)
  })

  it('does not end a part on the line that opens a code block', () => {
    // The only line break in reach is the one after the opening line.
    const before = 'x'.repeat(2900)
    const text = `${before}\n\`\`\`py\n${'y'.repeat(5000)}\n\`\`\`\n`

    const parts = bodies(splitIntoMessages(text, { maxBytes: 3000 }))

    expect(parts[0]).not.toContain('```py')
    expect(parts[1].startsWith('```py\n')).toBe(true)
  })

  it('never cuts an emoji sequence in two', () => {
    const family = '👨‍👩‍👧'
    const text = `${family}👍🏽`.repeat(200)

    const parts = splitIntoMessages(text, { maxChars: 300 })

    for (const body of bodies(parts)) {
      const clusters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(body)].map(s => s.segment)
      for (const cluster of clusters) expect([family, '👍🏽']).toContain(cluster)
    }
    expect(bodies(parts).join('')).toBe(text)
  })
})

describe('messageHead', () => {
  it('is the whole text when it fits', () => {
    expect(messageHead('short', { maxBytes: 100 })).toBe('short')
  })

  it('is the beginning that fits, cut where the first part would end', () => {
    const text = 'line of text\n'.repeat(500)

    const head = messageHead(text, { maxBytes: 1000 })

    expect(bytes(head)).toBeLessThanOrEqual(1000)
    expect(text.startsWith(head)).toBe(true)
    expect(head.endsWith('\n')).toBe(true)
  })

  it('closes a code block it ends inside', () => {
    const text = `\`\`\`\n${'echo hello\n'.repeat(500)}\`\`\``

    const head = messageHead(text, { maxBytes: 1000 })

    expect(bytes(head)).toBeLessThanOrEqual(1000)
    expect(head.endsWith('```')).toBe(true)
    expect((head.match(/^```/gm) ?? []).length).toBe(2)
  })
})

describe('sendAsMessages', () => {
  it('sends the parts one after another, each once the previous one settled', async () => {
    const text = 'paragraph text\n\n'.repeat(1000)
    const order: string[] = []
    let inFlight = 0

    const allSent = await sendAsMessages(text, { maxBytes: 4000 }, async (message, index) => {
      inFlight++
      expect(inFlight).toBe(1)
      await new Promise((resolve) => setTimeout(resolve, 1))
      order.push(`${index}:${message.slice(0, message.indexOf('\n'))}`)
      inFlight--
      return true
    })

    expect(allSent).toBe(true)
    const n = order.length
    expect(n).toBeGreaterThan(1)
    expect(order).toEqual(Array.from({ length: n }, (_, i) => `${i}:(${i + 1}/${n})`))
  })

  it('holds back the rest after a part fails and tells the chat where to read the reply', async () => {
    // A reply with a hole in it reads as whole; the note says it is not.
    const sent: string[] = []

    const allSent = await sendAsMessages('x'.repeat(10000), { maxBytes: 4000 }, async (message, index) => {
      sent.push(message)
      return index !== 1 || message.startsWith('回复')
    })

    expect(allSent).toBe(false)
    expect(sent).toHaveLength(3)
    expect(sent[0].startsWith('(1/3)')).toBe(true)
    expect(sent[1].startsWith('(2/3)')).toBe(true)
    expect(sent[2]).toBe('回复的第 2 条发送失败，完整内容请在 Halo 里查看')
  })

  it('says nothing more when the note itself does not go out, and when a single message fails', async () => {
    const attempts: string[] = []

    expect(await sendAsMessages('x'.repeat(10000), { maxBytes: 4000 }, async (message) => {
      attempts.push(message)
      return false
    })).toBe(false)
    expect(attempts).toHaveLength(2)

    attempts.length = 0
    expect(await sendAsMessages('short', { maxBytes: 4000 }, async (message) => {
      attempts.push(message)
      return false
    })).toBe(false)
    expect(attempts).toEqual(['short'])
  })

  it('sends a second reply to the same chat only after the first, and others alongside', async () => {
    const order: string[] = []
    const send = (tag: string) => async (message: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      order.push(`${tag}${message.slice(0, message.indexOf(')') + 1)}`)
      return true
    }
    const long = 'x'.repeat(10000)

    await Promise.all([
      sendAsMessages(long, { maxBytes: 4000 }, send('A'), { chat: 'bot:chat-1' }),
      sendAsMessages(long, { maxBytes: 4000 }, send('B'), { chat: 'bot:chat-1' }),
      sendAsMessages(long, { maxBytes: 4000 }, send('C'), { chat: 'bot:chat-2' }),
    ])

    const sameChat = order.filter((entry) => !entry.startsWith('C'))
    expect(sameChat).toEqual(['A(1/3)', 'A(2/3)', 'A(3/3)', 'B(1/3)', 'B(2/3)', 'B(3/3)'])
    // Another chat does not wait for this one.
    expect(order.indexOf('C(1/3)')).toBeLessThan(order.indexOf('A(3/3)'))
  })

  it('rethrows the first failure once the chat has been told', async () => {
    const sent: string[] = []

    await expect(sendAsMessagesOrThrow('x'.repeat(10000), { maxBytes: 4000 }, async (message, index) => {
      if (index === 1 && !message.startsWith('回复')) throw new Error('rate limited')
      sent.push(message)
    })).rejects.toThrow('rate limited')
    expect(sent).toEqual([expect.stringMatching(/^\(1\/3\)/), '回复的第 2 条发送失败，完整内容请在 Halo 里查看'])
  })

  it('sends a message that fits as it is', async () => {
    const messages: string[] = []

    await sendAsMessages('hello', { maxBytes: 4000 }, async (message) => {
      messages.push(message)
      return true
    })

    expect(messages).toEqual(['hello'])
  })
})
