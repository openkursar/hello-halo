/**
 * Commit area under the file list: the branch (shown, not switched) with its
 * ahead / behind counts from the last fetch — the network is used only when
 * the user syncs or pushes — the message box, and Commit with "Commit and
 * push" / "Amend last commit" beside it.
 */

import { useRef, useState, type KeyboardEvent } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, Check, ChevronDown, GitBranch, Loader2, UploadCloud, X } from 'lucide-react'
import type { GitRepository } from '../../../../../../shared/types/git'
import { useTranslation } from '../../../../../i18n'
import type { GitErrorText } from '../state/git-errors'
import { Menu, MenuItem } from '../shared/Menu'
import { IconButton, isCoarsePointer, isMacPlatform } from '../shared/parts'

interface CommitBoxProps {
  repo: GitRepository
  stagedCount: number
  /** The draft kept for the tab, shown when the box appears. */
  initialMessage: string
  /** Every edit of the draft, to keep it for the tab; the view does not re-render for it. */
  onDraftChange: (message: string) => void
  operation: 'commit' | 'push' | 'sync' | null
  /** Resolves true when the commit was made, and the draft is cleared. */
  onCommit: (options: { amend: boolean; push: boolean; message: string }) => Promise<boolean>
  onSync: () => void
  error: GitErrorText | null
  onDismissError: () => void
}

const COMMIT_KEY = isMacPlatform ? '⌘↵' : 'Ctrl+Enter'

export function CommitBox({ repo, stagedCount, initialMessage, onDraftChange, operation, onCommit, onSync, error, onDismissError }: CommitBoxProps) {
  const { t } = useTranslation()
  const [message, setMessage] = useState(initialMessage)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showOutput, setShowOutput] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const busy = operation !== null
  const hasMessage = message.trim() !== ''
  const canCommit = !busy && stagedCount > 0 && hasMessage
  const disabledReason = stagedCount === 0 ? t('Stage files to commit') : !hasMessage ? t('Enter a commit message') : undefined

  const edit = (next: string) => {
    setMessage(next)
    onDraftChange(next)
  }
  const commit = async (options: { amend: boolean; push: boolean }) => {
    if (await onCommit({ ...options, message: message.trim() })) edit('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (canCommit) void commit({ amend: false, push: false })
    }
  }

  const syncLabel = repo.upstream
    ? t('Sync with {{upstream}}: {{ahead}} to push, {{behind}} to pull', { upstream: repo.upstream, ahead: repo.ahead, behind: repo.behind })
    : t('Publish branch')

  return (
    <div className="flex flex-col gap-1.5 border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className="flex min-h-[24px] items-center gap-1.5 text-[12px] text-muted-foreground">
        <GitBranch size={13} className="shrink-0 text-faint-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={repo.branch ?? undefined}>
          {repo.branch ?? (repo.head ? t('Detached at {{commit}}', { commit: repo.head }) : t('No commits yet'))}
        </span>
        {repo.branch && (
          <button
            type="button"
            onClick={onSync}
            disabled={busy}
            aria-label={syncLabel}
            title={repo.upstream ? t('Counts are from the last fetch. Click to pull and push.') : undefined}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 font-mono text-[11.5px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {operation === 'sync' ? (
              <>
                <Loader2 size={12} className="animate-spin" aria-hidden />
                <span className="font-sans">{t('Syncing…')}</span>
              </>
            ) : repo.upstream ? (
              <>
                <ArrowUp size={12} aria-hidden />{repo.ahead}
                <ArrowDown size={12} aria-hidden />{repo.behind}
              </>
            ) : (
              <>
                <UploadCloud size={12} aria-hidden />
                <span className="font-sans">{t('Publish branch')}</span>
              </>
            )}
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-border bg-background px-2 py-1.5 text-[12px] text-foreground">
          <div className="flex items-start gap-1.5">
            <AlertCircle size={13} className="mt-0.5 shrink-0 text-destructive" aria-hidden />
            <span className="min-w-0 flex-1 break-words">{error.message}</span>
            <IconButton size="sm" label={t('Dismiss')} onClick={onDismissError} className="-mr-1 -mt-0.5">
              <X size={12} />
            </IconButton>
          </div>
          {error.output && (
            <>
              <button type="button" onClick={() => setShowOutput((v) => !v)} className="mt-1 text-[12px] text-primary hover:underline">
                {t('Show output')}
              </button>
              {showOutput && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-secondary p-1.5 font-mono text-[11px] text-foreground">
                  {error.output}
                </pre>
              )}
            </>
          )}
        </div>
      )}

      <textarea
        value={message}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={busy}
        rows={2}
        placeholder={isCoarsePointer ? t('Commit message') : t('Commit message ({{shortcut}} to commit)', { shortcut: COMMIT_KEY })}
        aria-label={t('Commit message')}
        className="max-h-40 min-h-[52px] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground outline-none placeholder:text-subtle-foreground focus:border-primary disabled:opacity-60"
      />

      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => void commit({ amend: false, push: false })}
          disabled={!canCommit}
          title={disabledReason}
          className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {operation === 'commit' || operation === 'push' ? <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden /> : <Check size={14} className="shrink-0" aria-hidden />}
          <span className="truncate">
            {operation === 'commit' ? t('Committing…') : operation === 'push' ? t('Pushing…') : t('Commit {{count}} staged files', { count: stagedCount })}
          </span>
        </button>
        <button
          ref={moreRef}
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={busy}
          aria-label={t('More commit options')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ChevronDown size={14} />
        </button>
        <Menu open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={moreRef} label={t('More commit options')} align="end">
          <MenuItem
            disabled={!canCommit}
            description={disabledReason}
            onSelect={() => {
              setMenuOpen(false)
              void commit({ amend: false, push: true })
            }}
          >
            {t('Commit and push')}
          </MenuItem>
          <MenuItem
            disabled={repo.unborn}
            description={t('Keeps its message if the box is empty')}
            onSelect={() => {
              setMenuOpen(false)
              void commit({ amend: true, push: false })
            }}
          >
            {t('Amend last commit')}
          </MenuItem>
        </Menu>
      </div>
    </div>
  )
}
