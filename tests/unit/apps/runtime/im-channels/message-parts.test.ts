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
  messageHead,
  sendAsMessages,
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
    const text = Array.from({ length: 40 }, () => paragraph).join('\n\n')

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

  it('always makes progress, even with a limit barely above the label', () => {
    const parts = splitIntoMessages('x'.repeat(100), { maxChars: 30 })

    for (const part of parts) expect(part.length).toBeLessThanOrEqual(30)
    expect(bodies(parts).join('')).toBe('x'.repeat(100))
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

  it('still sends the rest after a part fails, and says not everything went out', async () => {
    const sent: number[] = []

    const allSent = await sendAsMessages('x'.repeat(10000), { maxBytes: 4000 }, async (_message, index) => {
      sent.push(index)
      return index !== 1
    })

    expect(allSent).toBe(false)
    expect(sent).toEqual([0, 1, 2])
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
