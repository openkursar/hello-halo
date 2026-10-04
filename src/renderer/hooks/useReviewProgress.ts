/**
 * Progress of the latest AI review of a repository, for the changes view's
 * review card: whether it runs, what the reviewer is doing, its todo list,
 * its team, its cost, and the report once it is done.
 *
 * A review is an ordinary conversation of the space, usually not the one on
 * screen. While a record is passed, the hook keeps that conversation's live
 * detail flowing to this client (desktop and remote alike) and reads it in if
 * it is not cached — without selecting it or warming its session. A null
 * record does nothing at all.
 *
 * Renders follow what the card shows, not the stream: the live turn is read
 * through a selector cached per step list, so a token streaming in re-renders
 * nothing unless the todo list or the current action changed.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../api'
import { useChatStore } from '../stores/chat.store'
import { useComposerReferencesStore } from '../stores/composer-references.store'
import { useCollabSummary } from './useCollabSummary'
import { useConversationDetail } from './useConversationDetail'
import { describeThoughtActivity, latestTodos, type ThoughtActivity, type TodoItem } from '../utils/thought-activity'
import {
  deriveReviewProgress,
  EMPTY_REVIEW_PROGRESS,
  reviewSpan,
  type CollabEnd,
  type ReviewProgress,
} from '../utils/review-progress'
import type { CollabSummary, TeamEpochSummary } from '../../shared/apps/team-types'
import type { GitReviewRecord } from '../../shared/types/git'
import type { Thought } from '../types'

export type { ReviewProgress, ReviewProgressStatus, ReviewMember } from '../utils/review-progress'

interface LiveSignals {
  todosKey: string | null
  activityKey: string | null
}

const NO_LIVE_SIGNALS: LiveSignals = { todosKey: null, activityKey: null }

// Per step list: a selector runs on every store change, and most of those are
// tokens of other conversations, which leave this list untouched.
const liveSignalCache = new WeakMap<readonly Thought[], LiveSignals>()

function liveSignals(thoughts: readonly Thought[] | undefined): LiveSignals {
  if (!thoughts || thoughts.length === 0) return NO_LIVE_SIGNALS
  let signals = liveSignalCache.get(thoughts)
  if (!signals) {
    const todos = latestTodos(thoughts)
    signals = {
      todosKey: todos ? JSON.stringify(todos) : null,
      activityKey: JSON.stringify(describeThoughtActivity(thoughts)),
    }
    liveSignalCache.set(thoughts, signals)
  }
  return signals
}

/**
 * What a remount should not wait for: the last collaboration read per review
 * conversation, and how it ended. Bounded; a card shows one review at a time.
 */
const TEAM_MEMORY_LIMIT = 20
const collabMemory = new Map<string, CollabSummary | null>()
const endMemory = new Map<string, CollabEnd | null>()

function remember<T>(memory: Map<string, T>, key: string, value: T): void {
  memory.delete(key)
  memory.set(key, value)
  if (memory.size > TEAM_MEMORY_LIMIT) memory.delete(memory.keys().next().value as string)
}

export function useReviewProgress(record: GitReviewRecord | null, spaceId: string): ReviewProgress {
  const conversationId = record?.conversationId ?? null
  useConversationDetail(conversationId)

  const conversation = useChatStore(s => (conversationId ? s.conversationCache.get(conversationId) ?? null : null))
  const loadError = useChatStore(s => (conversationId ? s.conversationLoadErrors.get(conversationId) ?? null : null))
  const isGenerating = useChatStore(s => (conversationId ? s.sessions.get(conversationId)?.isGenerating ?? false : false))
  const sessionError = useChatStore(s => (conversationId ? s.sessions.get(conversationId)?.error ?? null : null))
  const sessionErrorType = useChatStore(s => (conversationId ? s.sessions.get(conversationId)?.errorType ?? null : null))
  const live = useChatStore(useShallow(s => (conversationId ? liveSignals(s.sessions.get(conversationId)?.thoughts) : NO_LIVE_SIGNALS)))

  const team = record?.variant === 'team'
  const fetchedCollab = useCollabSummary(team ? conversationId : null)
  const collab = fetchedCollab === undefined && conversationId ? collabMemory.get(conversationId) : fetchedCollab
  const endEpochId = collab && !collab.active ? collab.epochId : null
  const [end, setEnd] = useState<{ epochId: string; end: CollabEnd | null } | null>(null)
  const collabEnd = !endEpochId
    ? undefined
    : end?.epochId === endEpochId ? end.end : endMemory.get(endEpochId)

  // Read in once, without selecting or warming it.
  const openedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!conversationId || conversation || loadError || openedRef.current === conversationId) return
    openedRef.current = conversationId
    void useChatStore.getState().openConversation(conversationId, { warm: false })
  }, [conversationId, conversation, loadError])

  // The review conversation was created in the background: list it beside the
  // others. Checked once per review, not on every store change.
  const listedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!conversationId || listedRef.current === conversationId) return
    listedRef.current = conversationId
    const store = useChatStore.getState()
    if (store.spaceStates.get(spaceId)?.conversations.some(c => c.id === conversationId)) return
    void store.loadConversations(spaceId)
  }, [conversationId, spaceId])

  useEffect(() => {
    if (conversationId && fetchedCollab !== undefined) remember(collabMemory, conversationId, fetchedCollab)
  }, [conversationId, fetchedCollab])

  // Whether the team finished or was stopped is read once its work has ended.
  const endTeamId = collab && !collab.active ? collab.teamId : null
  useEffect(() => {
    if (!endTeamId || !endEpochId || collabEnd !== undefined) return
    let cancelled = false
    const settle = (value: CollabEnd | null) => {
      remember(endMemory, endEpochId, value)
      if (!cancelled) setEnd({ epochId: endEpochId, end: value })
    }
    api.teamListEpochs(endTeamId)
      .then(res => {
        const epoch = res.success ? ((res.data as TeamEpochSummary[] | undefined) ?? []).find(e => e.id === endEpochId) : undefined
        settle(epoch ? { reason: epoch.endReason, summary: epoch.summary } : null)
      })
      .catch(error => {
        console.warn('[ReviewProgress] Could not read how the review team ended:', error)
        settle(null)
      })
    return () => { cancelled = true }
  }, [endTeamId, endEpochId, collabEnd])

  // A starting turn clears its steps: keep showing the list the reviewer last wrote.
  const liveTodos = useMemo(() => (live.todosKey ? JSON.parse(live.todosKey) as TodoItem[] : null), [live.todosKey])
  const liveActivity = useMemo(() => (live.activityKey ? JSON.parse(live.activityKey) as ThoughtActivity : null), [live.activityKey])
  const heldTodosRef = useRef<{ conversationId: string; todos: TodoItem[] } | null>(null)
  if (conversationId && liveTodos) heldTodosRef.current = { conversationId, todos: liveTodos }
  const heldTodos = heldTodosRef.current?.conversationId === conversationId ? heldTodosRef.current.todos : null

  // After a reload nothing is held: while the review still runs, read the steps
  // of its latest reply once for the list it left.
  const messages = conversation?.messages
  const latestReply = useMemo(() => {
    const span = messages ? reviewSpan(messages) : null
    if (!messages || !span) return null
    for (let i = span.end - 1; i > span.start; i--) {
      if (messages[i].role === 'assistant') return messages[i]
    }
    return null
  }, [messages])
  const stillRunning = isGenerating || !!collab?.active
  const stepsReadRef = useRef<string | null>(null)
  useEffect(() => {
    if (!conversationId || !stillRunning || heldTodos || !latestReply || latestReply.thoughts !== null) return
    if (!latestReply.thoughtsSummary?.types.tool_use || stepsReadRef.current === latestReply.id) return
    stepsReadRef.current = latestReply.id
    void useChatStore.getState().loadMessageThoughts(conversation?.spaceId ?? spaceId, conversationId, latestReply.id)
  }, [conversationId, stillRunning, heldTodos, latestReply, conversation?.spaceId, spaceId])
  const earlierTodos = useMemo(
    () => heldTodos ?? (Array.isArray(latestReply?.thoughts) ? latestTodos(latestReply.thoughts) : null),
    [heldTodos, latestReply]
  )

  return useMemo(() => {
    if (!record) return EMPTY_REVIEW_PROGRESS
    return deriveReviewProgress({
      record,
      loadError,
      conversation: conversation
        ? { title: conversation.title, updatedAt: conversation.updatedAt, messages: conversation.messages }
        : null,
      isGenerating,
      sessionError,
      sessionErrorType,
      liveTodos,
      liveActivity,
      earlierTodos,
      collab: team ? collab : null,
      collabEnd: team ? collabEnd : null,
    })
  }, [record, loadError, conversation, isGenerating, sessionError, sessionErrorType, liveTodos, liveActivity, earlierTodos, team, collab, collabEnd])
}

/**
 * Stop a review: its current turn and, for a team review, the members still
 * working for it. The team's work is then closed without a summary, which is
 * how the card tells a stopped team review from a finished one.
 */
export async function stopReview(conversationId: string): Promise<void> {
  await useChatStore.getState().stopGeneration(conversationId)
  try {
    const res = await api.teamCollabForConversation(conversationId)
    const collab = res.success ? (res.data as CollabSummary | null) : null
    if (!collab?.active) return
    await Promise.all(collab.members
      .filter(m => m.status === 'working' || m.status === 'waiting_user')
      .map(m => api.teamStopMember({ teamId: collab.teamId, appId: m.appId, epochId: collab.epochId })))
    await api.teamArchiveConversation(collab.teamId, collab.epochId)
  } catch (error) {
    console.warn('[ReviewProgress] Could not stop the review team:', error)
  }
}

/** Show the review conversation in the chat, bringing the chat on screen if the canvas covers it. */
export async function enterReviewConversation(conversationId: string): Promise<void> {
  await useChatStore.getState().selectConversation(conversationId)
  const target = useComposerReferencesStore.getState().target
  if (target && !target.visible) target.reveal()
}
