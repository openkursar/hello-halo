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
import { isTeamTranscriptMessage } from '../../../../shared/transcript'
import { messageRowKey, messageRowKeys } from '../../../utils/message-row-key'
import { arrivedDuring } from './arrivals'

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
  /** Records received while a reply was written, by its id; drawn in its process (see `arrivals`). */
  readonly arrivals: ReadonlyMap<string, Message[]>
  /** Teammates' deliveries that opened a reply's turn, by its id; drawn as the reply's cause. */
  readonly openers: ReadonlyMap<string, Message[]>
  /** The running turn's openers: its reply is drawn from the stream, not from these rows. */
  readonly liveOpeners: readonly Message[]
  /** Index in `source` of each row. */
  readonly sourceIndexes: readonly number[]
  /** Source index of each reply owning injected messages, arrivals or openers. */
  readonly attachmentOwners: ReadonlyMap<string, number>
  /** Row index of each key at the last full build, covering the first `indexedRows` rows. */
  readonly keyRows: ReadonlyMap<string, number>
  readonly indexedRows: number
}

function isProcessInput(message: Message): boolean {
  return message.source === 'injection' || message.role === 'system'
}

/** The last message not received into running work: the one a running turn's placeholder can be. */
function lastPlainIndex(source: readonly Message[]): number {
  let index = source.length - 1
  while (index >= 0 && (source[index].source === 'injection' || source[index].metadata?.inputMode === 'live')) index--
  return index
}

function isHiddenPlaceholder(message: Message, index: number, lastPlain: number, isGenerating: boolean): boolean {
  return isGenerating && index === lastPlain && message.role === 'assistant' && !message.content
}

function costAfter(message: Message, before: number): number {
  return message.role === 'assistant' && message.tokenUsage?.totalCostUsd ? message.tokenUsage.totalCostUsd : before
}

/** What a reply carries besides itself: drawn on it, never as rows of their own. */
export interface ReplyInputs {
  injections: Message[]
  arrivals: Message[]
}

/**
 * The owner's additions right after the reply at `index`, and the records that
 * name it as the reply open at their receipt. Ownership is the writer's
 * statement; adjacency alone attaches nothing else.
 */
function inputsFor(source: readonly Message[], index: number): ReplyInputs {
  const injections: Message[] = []
  const arrivals: Message[] = []
  const reply = source[index]
  let contiguous = true
  for (let at = index + 1; at < source.length && isProcessInput(source[at]); at++) {
    const message = source[at]
    if (arrivedDuring(message, reply)) arrivals.push(message)
    else if (contiguous && message.source === 'injection') injections.push(message)
    else contiguous = false
  }
  return { injections, arrivals }
}

/** The reply whose sender line draws the opener `messageId`, if any. */
export function openerOwner(rows: TranscriptRows, messageId: string): string | undefined {
  for (const [replyId, opened] of rows.openers) {
    if (opened.some(message => message.id === messageId)) return replyId
  }
  return undefined
}

/** The same attachment by reply id, for views that draw their own selection of a transcript. */
export function inputsByReply(messages: readonly Message[]): Map<string, ReplyInputs> {
  const byReply = new Map<string, ReplyInputs>()
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return
    const inputs = inputsFor(messages, index)
    if (inputs.injections.length || inputs.arrivals.length) byReply.set(message.id, inputs)
  })
  return byReply
}

/** A teammate's delivery that opened a turn; the writer states it with `inputMode: 'turn'`. */
function isTurnOpener(message: Message): boolean {
  return isTeamTranscriptMessage(message) && message.metadata?.inputMode === 'turn'
}

function isOwnReply(message: Message | undefined): boolean {
  return message?.role === 'assistant' && message.source !== 'push'
}

/** The openers right before the reply at `index`: the turn that reply answers. */
function openersFor(source: readonly Message[], index: number): Message[] {
  let at = index
  while (at > 0 && isTurnOpener(source[at - 1])) at--
  return at === index ? [] : source.slice(at, index)
}

/**
 * Whether the opener at `index` is drawn on a reply instead of as its own card:
 * its run of openers is followed by the reply it opened, or, while a turn runs,
 * ends the transcript (that reply is still the stream).
 */
function isAttachedOpener(source: readonly Message[], index: number, isGenerating: boolean): boolean {
  if (!isTurnOpener(source[index])) return false
  let at = index + 1
  while (at < source.length && isTurnOpener(source[at])) at++
  return at === source.length ? isGenerating : isOwnReply(source[at])
}

function trailingOpeners(source: readonly Message[], isGenerating: boolean): Message[] {
  return isGenerating ? openersFor(source, source.length) : []
}

function attachedArrivals(source: readonly Message[], from = 0): Set<Message> {
  const attached = new Set<Message>()
  let at = from
  while (at < source.length) {
    if (!isProcessInput(source[at])) { at++; continue }
    const previousReply = source[at - 1]
    for (; at < source.length && isProcessInput(source[at]); at++) {
      if (arrivedDuring(source[at], previousReply)) attached.add(source[at])
    }
  }
  return attached
}

function buildRows(source: readonly Message[], isGenerating: boolean): TranscriptRows {
  const messages: Message[] = []
  const sourceIndexes: number[] = []
  const previousCosts: number[] = []
  const injections = new Map<string, Message[]>()
  const arrivals = new Map<string, Message[]>()
  const openers = new Map<string, Message[]>()
  const attachmentOwners = new Map<string, number>()
  const lastPlain = lastPlainIndex(source)
  let liveOpeners = trailingOpeners(source, isGenerating)
  let lastCost = 0
  const attached = attachedArrivals(source)
  for (let i = 0; i < source.length; i++) {
    const message = source[i]
    if (message.source === 'injection' || attached.has(message) || isAttachedOpener(source, i, isGenerating)) continue
    if (message.role === 'assistant') {
      const inputs = inputsFor(source, i)
      const opened = isOwnReply(message) ? openersFor(source, i) : []
      if (inputs.injections.length) injections.set(message.id, inputs.injections)
      if (inputs.arrivals.length) arrivals.set(message.id, inputs.arrivals)
      if (opened.length) openers.set(message.id, opened)
      if (inputs.injections.length || inputs.arrivals.length || opened.length) attachmentOwners.set(message.id, i)
    }
    if (isHiddenPlaceholder(message, i, lastPlain, isGenerating)) {
      liveOpeners = openers.get(message.id) ?? liveOpeners
      continue
    }
    messages.push(message)
    sourceIndexes.push(i)
    previousCosts.push(lastCost)
    lastCost = costAfter(message, lastCost)
  }
  const keys = messageRowKeys(messages)
  return {
    source, isGenerating, messages, keys, previousCosts, injections, arrivals, openers, liveOpeners, sourceIndexes, attachmentOwners,
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
  // A reply owns the inputs after it: derive it again with them.
  while (from > 0 && isProcessInput(source[from - 1])) from--
  if (from > 0 && source[from - 1].role === 'assistant') from--
  if (from === 0) return buildRows(source, isGenerating)

  const keepRows = rowsBefore(prev.sourceIndexes, from)
  const indexedRows = Math.min(prev.indexedRows, keepRows)
  const messages = prev.messages.slice(0, keepRows)
  const sourceIndexes = prev.sourceIndexes.slice(0, keepRows)
  const previousCosts = prev.previousCosts.slice(0, keepRows)
  const keys = prev.keys.slice(0, keepRows)
  let injections = prev.injections as Map<string, Message[]>
  let arrivals = prev.arrivals as Map<string, Message[]>
  let openers = prev.openers as Map<string, Message[]>
  let attachmentOwners = prev.attachmentOwners as Map<string, number>
  const own = () => {
    if (attachmentOwners !== prev.attachmentOwners) return
    injections = new Map(prev.injections)
    arrivals = new Map(prev.arrivals)
    openers = new Map(prev.openers)
    attachmentOwners = new Map(prev.attachmentOwners)
  }
  for (const [id, owner] of prev.attachmentOwners) {
    if (owner < from) continue
    own()
    injections.delete(id)
    arrivals.delete(id)
    openers.delete(id)
    attachmentOwners.delete(id)
  }
  let lastCost = keepRows > 0 ? costAfter(messages[keepRows - 1], previousCosts[keepRows - 1]) : 0
  // Both places a running turn's openers can sit, the end or its placeholder, are at or after `from`.
  let liveOpeners = trailingOpeners(source, isGenerating)

  const attached = attachedArrivals(source, from)
  for (let i = from; i < source.length; i++) {
    const message = source[i]
    if (message.source === 'injection' || attached.has(message) || isAttachedOpener(source, i, isGenerating)) continue
    if (message.role === 'assistant') {
      const inputs = inputsFor(source, i)
      const opened = isOwnReply(message) ? openersFor(source, i) : []
      if (inputs.injections.length || inputs.arrivals.length || opened.length) {
        own()
        if (inputs.injections.length) injections.set(message.id, inputs.injections)
        if (inputs.arrivals.length) arrivals.set(message.id, inputs.arrivals)
        if (opened.length) openers.set(message.id, opened)
        attachmentOwners.set(message.id, i)
      }
    }
    if (isHiddenPlaceholder(message, i, lastPlain, isGenerating)) {
      liveOpeners = openers.get(message.id) ?? liveOpeners
      continue
    }
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
    source, isGenerating, messages, keys, previousCosts, injections, arrivals, openers, liveOpeners, sourceIndexes, attachmentOwners,
    keyRows: prev.keyRows,
    indexedRows,
  }
}
