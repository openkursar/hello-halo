import type { ExecutionEnvironment, WorkspaceNoticeKind } from '../../../shared/apps/app-types'
import { WORKSPACE_NOTICE_TEXT } from '../../../shared/transcript'

export function workspaceNoticeForModel(kind: WorkspaceNoticeKind): string {
  return '[Workspace changed]\n' + (kind === 'deleted'
    ? 'The previous workspace was deleted. This conversation continues in your current workspace with its memory and history. Check old file paths before relying on them.'
    : 'The previous workspace is unavailable. This conversation continues in your current workspace. Earlier messages, memory and files at the old location may be unavailable; do not assume they were deleted.')
}

/** Transcript persistence and engine acceptance are separate checkpoints across failed preparation and retries. */
export function prepareWorkspaceNotice(
  environment: ExecutionEnvironment,
  record: (text: string) => boolean,
  save: () => void,
): { context: string; delivered(): void } {
  const notice = environment.pendingWorkspaceNotice
  if (!notice) return { context: '', delivered() {} }
  if (!notice.recorded && record(WORKSPACE_NOTICE_TEXT[notice.kind])) {
    notice.recorded = true
    save()
  }
  return {
    context: workspaceNoticeForModel(notice.kind),
    delivered() {
      if (!notice.recorded || environment.pendingWorkspaceNotice !== notice) return
      delete environment.pendingWorkspaceNotice
      try { save() }
      catch (error) { environment.pendingWorkspaceNotice = notice; throw error }
    },
  }
}
