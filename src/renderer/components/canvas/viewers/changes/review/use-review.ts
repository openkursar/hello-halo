/**
 * The review card's data and actions for one repository: the latest review's
 * progress, whether a team review can run, how many files changed since the
 * reviewed snapshot, and starting, stopping and following a review.
 *
 * Used by the card itself, which exists only while the overview is on
 * screen: nothing is followed or counted for a review nobody is looking at.
 */

import { useCallback, useEffect, useState } from 'react'
import type { CodeReviewAvailability } from '../../../../../../shared/types/code-review'
import type { GitChangeList, GitReviewRecord } from '../../../../../../shared/types/git'
import { useTranslation } from '../../../../../i18n'
import { enterReviewConversation, stopReview, useReviewProgress } from '../../../../../hooks/useReviewProgress'
import { addReference } from '../../../../references'
import { failureOf, gitClient } from '../state/git-client'
import type { ChangedSinceCounter } from './changed-since'
import { refusalText, reviewCardState, type ReviewCardState, type ReviewVariant } from './review-state'

interface UseReviewOptions {
  spaceId: string
  record: GitReviewRecord | null
  /** The list on screen: what a new review reviews. */
  list: GitChangeList | null
  repoRoot: string | null
  scopeLabel: string
  /** Bumped when the user refreshes or discards (see `ChangedSinceCounter`). */
  recount: number
  /** The view's count of files changed since the review, kept across appearances of the card. */
  changedSince: ChangedSinceCounter
  /** How many file changes the view has seen; read once, when the card appears. */
  treeVersion: () => number
  onStarted: (record: GitReviewRecord) => void
}

export interface ReviewModel {
  card: ReviewCardState
  team: CodeReviewAvailability['team'] | null
  starting: ReviewVariant | null
  startError: { variant: ReviewVariant; message: string } | null
  start: (variant: ReviewVariant) => void
  stop: () => void
  openConversation: () => void
  addReport: () => void
}

export function useReview({ spaceId, record, list, repoRoot, scopeLabel, recount, changedSince, treeVersion, onStarted }: UseReviewOptions): ReviewModel {
  const { t, i18n } = useTranslation()
  const progress = useReviewProgress(record, spaceId)
  const [team, setTeam] = useState<CodeReviewAvailability['team'] | null>(null)
  const [starting, setStarting] = useState<ReviewVariant | null>(null)
  const [startError, setStartError] = useState<ReviewModel['startError']>(null)
  // The last count shows at once, so coming back to the card does not make its note blink.
  const [changed, setChanged] = useState<{ snapshot: string; count: number } | null>(() => {
    const count = record ? changedSince.lastFor(record.snapshot) : null
    return record && count !== null ? { snapshot: record.snapshot, count } : null
  })
  const [seen] = useState(() => treeVersion())

  useEffect(() => {
    let cancelled = false
    gitClient.reviewAvailability().then(
      (availability) => {
        if (!cancelled) setTeam(availability.team)
      },
      (error: unknown) => {
        // Unknown availability leaves the team review enabled; a refusal then says why.
        console.warn('[ChangesView] Could not read review availability:', failureOf(error))
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const done = record !== null && progress.status === 'done'
  const snapshot = record?.snapshot
  const reviewedRoot = record?.repoRoot
  useEffect(() => {
    if (!done || !snapshot || !reviewedRoot) return
    let current = true
    const count = () => gitClient.countChangedSince(spaceId, reviewedRoot, snapshot).catch((error: unknown) => {
      // Only the "changed since" note is lost (the snapshot may have been pruned).
      console.warn('[ChangesView] Could not count changes since the review:', failureOf(error))
      return 0
    })
    void changedSince.countFor(snapshot, recount, seen, count).then((value) => {
      if (!current) return
      setChanged((previous) => (previous?.snapshot === snapshot && previous.count === value ? previous : { snapshot, count: value }))
    })
    return () => {
      current = false
    }
  }, [snapshot, reviewedRoot, done, recount, spaceId, changedSince, seen])

  const changedCount = changed && changed.snapshot === snapshot ? changed.count : 0
  const card = reviewCardState(record, progress, changedCount)

  const start = useCallback((variant: ReviewVariant) => {
    if (!repoRoot || !list || starting) return
    const fileCount = list.files.length
    setStarting(variant)
    setStartError(null)
    gitClient.startReview({
      spaceId,
      repoRoot,
      variant,
      scope: list.scope,
      scopeLabel,
      fileCount,
      language: i18n.language,
      title: t('Review · {{scope}} · {{count}} files', { scope: scopeLabel, count: fileCount }),
    }).then(
      (result) => {
        if (result.ok) onStarted(result.record)
        else setStartError({ variant, message: refusalText(result.reason, result.message, t) })
      },
      (error: unknown) => {
        setStartError({ variant, message: failureOf(error).error || t('Something went wrong') })
      }
    ).finally(() => setStarting(null))
  }, [spaceId, repoRoot, list, scopeLabel, starting, onStarted, t, i18n.language])

  const conversationId = record?.conversationId
  const stop = useCallback(() => {
    if (conversationId) void stopReview(conversationId)
  }, [conversationId])
  const openConversation = useCallback(() => {
    if (conversationId) void enterReviewConversation(conversationId)
  }, [conversationId])

  const report = card.kind === 'done' ? card.report : null
  const reportTitle = card.kind === 'done' ? card.conversationTitle : null
  const addReport = useCallback(() => {
    if (!conversationId || !report) return
    addReference({
      source: {
        kind: 'message',
        conversationId,
        messageId: report.messageId,
        ...(reportTitle ? { conversationTitle: reportTitle } : {}),
        whole: true,
      },
      quote: report.content,
    }, { focusComposer: true })
  }, [conversationId, report, reportTitle])

  return { card, team, starting, startError, start, stop, openConversation, addReport }
}
