/**
 * The card a task-starting user message shows instead of text — today a code
 * review launched from the changes view. Clicking it opens that repository's
 * changes view on the review page.
 */

import { ScanSearch } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { canvasLifecycle } from '../../services/canvas-lifecycle'
import { useSpaceStore } from '../../stores/space.store'
import type { MessageTask } from '../../../shared/types/message-task'

interface MessageTaskCardProps {
  task: MessageTask
  /** Overrides what a click does (the default opens the review page). */
  onOpen?: (task: MessageTask) => void
}

function openReviewPage(task: MessageTask): void {
  const spaceId = useSpaceStore.getState().currentSpace?.id
  if (!spaceId) return
  void canvasLifecycle.openChanges({ kind: 'git', spaceId, repoRoot: task.repoRoot }, { reveal: { page: 'overview' } })
}

export function MessageTaskCard({ task, onOpen = openReviewPage }: MessageTaskCardProps) {
  const { t } = useTranslation()
  const title = task.variant === 'team' ? t('Team review') : t('Quick review')
  return (
    <button
      type="button"
      onClick={() => onOpen(task)}
      className="flex max-w-full items-start gap-2 rounded-[9px] border border-border bg-card px-2.5 py-2 text-left
        transition-colors ease-halo hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        <ScanSearch size={14} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-medium text-foreground">{title}</span>
        <span className="truncate text-[12px] text-muted-foreground">
          {t('{{repo}} · {{scope}} · {{count}} files', { repo: task.repoName, scope: task.scopeLabel, count: task.fileCount })}
        </span>
      </span>
    </button>
  )
}
