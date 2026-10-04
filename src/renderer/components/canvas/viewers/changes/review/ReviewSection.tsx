/**
 * The review card with its data: mounted with the overview, so a review's
 * progress re-renders only this part of the view, and nothing is followed or
 * counted while the overview is off screen.
 */

import type { GitChangeList, GitReviewRecord } from '../../../../../../shared/types/git'
import type { FileLinkTarget } from '../../../../references'
import type { ChangedSinceCounter } from './changed-since'
import { ReviewCard } from './ReviewCard'
import { ReviewReport } from './ReviewReport'
import { useReview } from './use-review'

interface ReviewSectionProps {
  spaceId: string
  record: GitReviewRecord | null
  list: GitChangeList | null
  repoRoot: string | null
  scopeLabel: string
  /** Bumped when the user refreshes or discards. */
  recount: number
  /** Lives as long as the view, so the count outlasts the card. */
  changedSince: ChangedSinceCounter
  /** How many file changes the view has seen. */
  treeVersion: () => number
  onStarted: (record: GitReviewRecord) => void
  /**
   * A report link was followed: `mention` is its index among the report's
   * file mentions, `report` the report's text. Return false to open the file
   * in the canvas instead.
   */
  onOpenReportFile: (target: FileLinkTarget, mention: number, report: string) => boolean
  /** Mention to point at, after coming back from a link. */
  returnTo: number | null
}

export function ReviewSection({ spaceId, record, list, repoRoot, scopeLabel, recount, changedSince, treeVersion, onStarted, onOpenReportFile, returnTo }: ReviewSectionProps) {
  const review = useReview({ spaceId, record, list, repoRoot, scopeLabel, recount, changedSince, treeVersion, onStarted })
  return (
    <ReviewCard
      state={review.card}
      team={review.team}
      nothingToReview={!list || list.files.length === 0}
      starting={review.starting}
      startError={review.startError}
      onStart={review.start}
      onStop={review.stop}
      onOpenConversation={review.openConversation}
      onAddReport={review.addReport}
      renderReport={(done) => record && (
        <ReviewReport
          spaceId={spaceId}
          conversationId={record.conversationId}
          messageId={done.report.messageId}
          content={done.report.content}
          conversationTitle={done.conversationTitle}
          onOpenFile={(target, mention) => onOpenReportFile(target, mention, done.report.content)}
          returnTo={returnTo}
        />
      )}
    />
  )
}
