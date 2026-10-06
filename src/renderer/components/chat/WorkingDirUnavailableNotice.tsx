/**
 * A turn could not start because its workspace's folder is gone — moved,
 * deleted, or on a drive that is not connected. Says which folder, and lets
 * the person point the workspace at another one right here; conversations,
 * digital humans and memory stay as they are.
 */

import { FolderX } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useChangeWorkingDir } from '../space/useChangeWorkingDir'
import type { WorkDirIssue } from '../../types'

export function WorkingDirUnavailableNotice({ issue }: { issue: WorkDirIssue }) {
  const { t } = useTranslation()
  const { change, status, available } = useChangeWorkingDir(issue.spaceId)

  return (
    <div className="rounded-2xl px-4 py-3 bg-destructive/10 border border-destructive/30">
      <div className="flex items-center gap-2 text-destructive">
        <FolderX className="w-4 h-4 flex-shrink-0" />
        <span className="text-sm font-medium">{t('The working directory is unavailable')}</span>
      </div>
      <p className="mt-2 text-sm text-destructive/80 break-all">{issue.workDir}</p>
      {status.state === 'changed' ? (
        <p className="mt-2 text-sm text-foreground break-all">
          {t('The working directory is now {{path}}. Send your message again.', { path: status.workingDir })}
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('It may have been moved, deleted or disconnected. Choose another folder for this workspace, or restore this one and send again.')}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void change()}
              disabled={!available || status.state === 'changing'}
              className="h-8 px-3 rounded-sm border border-border bg-secondary text-foreground text-xs font-medium hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('Change working directory')}
            </button>
            {!available && <span className="text-xs text-muted-foreground">{t('The folder can only be changed in the desktop app.')}</span>}
          </div>
        </>
      )}
      {status.state === 'failed' && (
        <p className="mt-2 text-xs text-destructive">{t('Could not change the working directory: {{error}}', { error: status.error })}</p>
      )}
    </div>
  )
}
