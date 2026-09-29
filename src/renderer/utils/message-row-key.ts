import type { Message } from '../types'

/**
 * React identity of a transcript row: the id it is stored under, unless the
 * view already drew it under another one (an optimistic message keeps its
 * bubble when the persisted twin arrives).
 */
export function messageRowKey(message: Pick<Message, 'id' | 'clientKey'>): string {
  return message.clientKey ?? message.id
}

/** Row keys for a list, unique even if a source ever repeats an id. */
export function messageRowKeys(messages: readonly Pick<Message, 'id' | 'clientKey'>[]): string[] {
  const seen = new Map<string, number>()
  return messages.map(message => {
    const key = messageRowKey(message)
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)
    return occurrence === 0 ? key : `${key}#${occurrence}`
  })
}
