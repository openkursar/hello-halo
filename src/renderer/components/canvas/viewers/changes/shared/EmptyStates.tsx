/**
 * What the changes view says when there is nothing to show: no changes for
 * the compare scope, no repository in the space, no Git on the computer, or a
 * repository that could not be read.
 */

import type { ReactNode } from 'react'
import { AlertCircle, CheckCircle2, FolderX, Loader2, TerminalSquare } from 'lucide-react'
import type { GitAvailability } from '../../../../../../shared/types/git'
import { api } from '../../../../../api'
import { useTranslation } from '../../../../../i18n'
import { useAppStore } from '../../../../../stores/app.store'
import { revisionName } from '../model/scope'
import type { StoredCompareScope } from '../../../../../types/changes-view'

function Shell({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">{icon}</div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {children}
      </div>
    </div>
  )
}

export function LoadingState() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-subtle-foreground" role="status">
      <Loader2 size={16} className="animate-spin" aria-hidden />
      {t('Loading changes…')}
    </div>
  )
}

export function NoChangesState({ scope }: { scope: StoredCompareScope }) {
  const { t } = useTranslation()
  const title = scope.kind === 'staged' ? t('Nothing staged')
    : scope.kind === 'since-review' ? t('No changes since the last review')
      : scope.kind === 'revision' ? t('No differences from {{revision}}', { revision: revisionName(scope.revision) })
        : t('No changes')
  return (
    <Shell icon={<CheckCircle2 size={20} />} title={title}>
      {scope.kind === 'uncommitted' && <p className="text-[13px] text-subtle-foreground">{t('The working tree matches HEAD.')}</p>}
    </Shell>
  )
}

export function NoRepositoryState() {
  const { t } = useTranslation()
  return (
    <Shell icon={<FolderX size={20} />} title={t('This space isn\'t a Git repository')}>
      <p className="text-[13px] text-subtle-foreground">{t('Halo looks for a repository in the space folder and the folders directly inside it.')}</p>
    </Shell>
  )
}

export function NoGitState({ git, onRetry }: { git: Extract<GitAvailability, { available: false }>; onRetry: () => void }) {
  const { t } = useTranslation()
  const progress = useAppStore((s) => s.gitBashInstallProgress)
  const install = useAppStore((s) => s.startGitBashInstall)
  // Installing is offered where Halo can do it: the Windows desktop app.
  const canInstall = !api.isRemoteMode() && !!window.platform?.isWindows
  const installing = progress.phase === 'downloading' || progress.phase === 'extracting' || progress.phase === 'configuring'
  const notRunnable = git.reason === 'not-runnable'
  const macTools = notRunnable && !!window.platform?.isMac

  return (
    <Shell icon={<TerminalSquare size={20} />} title={notRunnable ? t('Git can\'t run on this computer') : t('Git isn\'t installed')}>
      {macTools && (
        <p className="text-[13px] text-subtle-foreground">
          {t('Git needs the Xcode Command Line Tools. Run “xcode-select --install” in Terminal, then try again.')}
        </p>
      )}
      {git.detail && !macTools && <p className="break-words font-mono text-[11.5px] text-subtle-foreground">{git.detail}</p>}
      <div className="mt-2 flex items-center gap-2">
        {canInstall && (
          <button
            type="button"
            onClick={() => void install().then(onRetry)}
            disabled={installing}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
          >
            {installing && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {t('Install Git')}
          </button>
        )}
        <button
          type="button"
          onClick={onRetry}
          className="h-8 rounded-md border border-border bg-secondary px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover"
        >
          {t('Try again')}
        </button>
      </div>
      {progress.phase === 'error' && progress.error && (
        <p role="alert" className="flex items-start gap-1.5 text-left text-[12px] text-foreground">
          <AlertCircle size={13} className="mt-0.5 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0 break-words">{progress.error}</span>
        </p>
      )}
    </Shell>
  )
}

export function LoadErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <Shell icon={<AlertCircle size={20} />} title={t('Couldn\'t read this repository')}>
      <p className="break-words text-[13px] text-subtle-foreground">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 h-8 rounded-md border border-border bg-secondary px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover"
      >
        {t('Try again')}
      </button>
    </Shell>
  )
}
