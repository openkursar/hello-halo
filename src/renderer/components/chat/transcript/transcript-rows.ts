/**
 * The rows a transcript draws and what each row needs from its neighbours,
 * derived again only for the messages that changed.
 *
 * A transcript changes at its end (a message sent, a turn started or settled)
 * and keeps every unchanged message object (`reconcileTranscript`), so rows
 * before the first changed message are kept and only the tail is derived
 * again. Changes elsewhere — another conversation, an older page, a repeated
 * key — fall back to a full build.
 */

import type { Message } from '../../../types'
import { messageRowKey, messageRowKeys } from '../../../utils/message-row-key'

/** Rows appended since the last full build whose keys are checked one by one. */
const MAX_UNINDEXED_KEYS = 256

export interface TranscriptRows {
  /** The messages these rows were built from. */
  readonly source: readonly Message[]
  readonly isGenerating: boolean
  /**
   * Messages drawn as rows. Injected messages are shown on the reply they
   * follow, and a running turn's empty reply placeholder is not drawn.
   */
  readonly messages: readonly Message[]
  /** React identity of each row (`messageRowKeys`). */
  readonly keys: readonly string[]
  /** Cumulative cost of the latest priced reply before each row; the row shows the difference. */
  readonly previousCosts: readonly number[]
  /** Injected messages by the id of the reply they follow. */
  readonly injections: ReadonlyMap<string, Message[]>
  /** Index in `source` of each row. */
  readonly sourceIndexes: readonly number[]
  /** Source index of each reply in `injections`. */
  readonly injectionOwners: ReadonlyMap<string, number>
  /** Row index of each key at the last full build, covering the first `indexedRows` rows. */
  readonly keyRows: ReadonlyMap<string, number>
  readonly indexedRows: number
}

/** The last message that is not an injection: the one a running turn's placeholder can be. */
function lastPlainIndex(source: readonly Message[]): number {
  let index = source.length - 1
  while (index >= 0 && source[index].source === 'injection') index--
  return index
}

function isHiddenPlaceholder(message: Message, index: number, lastPlain: number, isGenerating: boolean): boolean {
  return isGenerating && index === lastPlain && message.role === 'assistant' && !message.content
}

function costAfter(message: Message, before: number): number {
  return message.role === 'assistant' && message.tokenUsage?.totalCostUsd ? message.tokenUsage.totalCostUsd : before
}

/** The run of injected messages following `index`, or null. */
function injectedAfter(source: readonly Message[], index: number): Message[] | null {
  let end = index + 1
  while (end < source.length && source[end].source === 'injection') end++
  return end > index + 1 ? source.slice(index + 1, end) : null
}

function buildRows(source: readonly Message[], isGenerating: boolean): TranscriptRows {
  const messages: Message[] = []
  const sourceIndexes: number[] = []
  const previousCosts: number[] = []
  const injections = new Map<string, Message[]>()
  const injectionOwners = new Map<string, number>()
  const lastPlain = lastPlainIndex(source)
  let lastCost = 0
  for (let i = 0; i < source.length; i++) {
    const message = source[i]
    if (message.source === 'injection') continue
    if (message.role === 'assistant') {
      const injected = injectedAfter(source, i)
      if (injected) {
        injections.set(message.id, injected)
        injectionOwners.set(message.id, i)
      }
    }
    if (isHiddenPlaceholder(message, i, lastPlain, isGenerating)) continue
    messages.push(message)
    sourceIndexes.push(i)
    previousCosts.push(lastCost)
    lastCost = costAfter(message, lastCost)
  }
  const keys = messageRowKeys(messages)
  return {
    source, isGenerating, messages, keys, previousCosts, injections, sourceIndexes, injectionOwners,
    keyRows: new Map(keys.map((key, row) => [key, row])),
    indexedRows: keys.length,
  }
}

/** Number of rows whose source index is below `from`. */
function rowsBefore(sourceIndexes: readonly number[], from: number): number {
  let low = 0
  let high = sourceIndexes.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (sourceIndexes[mid] < from) low = mid + 1
    else high = mid
  }
  return low
}

/** The rows for `source`, deriving again only from the first message that changed since `prev`. */
export function nextTranscriptRows(prev: TranscriptRows | null, source: readonly Message[], isGenerating: boolean): TranscriptRows {
  if (prev && prev.source === source && prev.isGenerating === isGenerating) return prev
  if (!prev || prev.source.length === 0 || source.length === 0) return buildRows(source, isGenerating)

  const shared = Math.min(prev.source.length, source.length)
  let from = 0
  while (from < shared && prev.source[from] === source[from]) from++
  // Whether the last plain message is drawn depended on it being last.
  const lastPlain = lastPlainIndex(source)
  from = Math.min(from, Math.max(0, lastPlainIndex(prev.source)), Math.max(0, lastPlain))
  // A reply owns the injected messages after it: derive it again with them.
  while (from > 0 && source[from - 1].source === 'injection') from--
  if (from > 0 && source[from - 1].role === 'assistant') from--
  if (from === 0) return buildRows(source, isGenerating)

  const keepRows = rowsBefore(prev.sourceIndexes, from)
  const indexedRows = Math.min(prev.indexedRows, keepRows)
  const messages = prev.messages.slice(0, keepRows)
  const sourceIndexes = prev.sourceIndexes.slice(0, keepRows)
  const previousCosts = prev.previousCosts.slice(0, keepRows)
  const keys = prev.keys.slice(0, keepRows)
  let injections = prev.injections as Map<string, Message[]>
  let injectionOwners = prev.injectionOwners as Map<string, number>
  for (const [id, owner] of prev.injectionOwners) {
    if (owner < from) continue
    if (injections === prev.injections) {
      injections = new Map(prev.injections)
      injectionOwners = new Map(prev.injectionOwners)
    }
    injections.delete(id)
    injectionOwners.delete(id)
  }
  let lastCost = keepRows > 0 ? costAfter(messages[keepRows - 1], previousCosts[keepRows - 1]) : 0

  for (let i = from; i < source.length; i++) {
    const message = source[i]
    if (message.source === 'injection') continue
    if (message.role === 'assistant') {
      const injected = injectedAfter(source, i)
      if (injected) {
        if (injections === prev.injections) {
          injections = new Map(prev.injections)
          injectionOwners = new Map(prev.injectionOwners)
        }
        injections.set(message.id, injected)
        injectionOwners.set(message.id, i)
      }
    }
    if (isHiddenPlaceholder(message, i, lastPlain, isGenerating)) continue
    const key = messageRowKey(message)
    const indexedAt = prev.keyRows.get(key)
    // A repeated key needs the suffixes only a full build assigns.
    if ((indexedAt !== undefined && indexedAt < indexedRows && keys[indexedAt] === key) || keys.indexOf(key, indexedRows) !== -1) {
      return buildRows(source, isGenerating)
    }
    messages.push(message)
    sourceIndexes.push(i)
    previousCosts.push(lastCost)
    keys.push(key)
    lastCost = costAfter(message, lastCost)
  }
  if (keys.length - indexedRows > MAX_UNINDEXED_KEYS) return buildRows(source, isGenerating)

  return {
    source, isGenerating, messages, keys, previousCosts, injections, sourceIndexes, injectionOwners,
    keyRows: prev.keyRows,
    indexedRows,
  }
}
