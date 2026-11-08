import { useEffect, useRef, useState } from 'react'
import { BookMarked, ChevronDown, FolderOpen } from 'lucide-react'
import type { GitRepository, GitRepositoryList } from '../../../../../../shared/types/git'
import { api } from '../../../../../api'
import { useTranslation } from '../../../../../i18n'
import { failureOf } from '../state/git-client'
import { gitErrorMessage, repositorySelectionError, type GitFailure } from '../state/git-errors'
import { Menu, MenuItem, MenuLabel, MenuNote, MenuSeparator } from '../shared/Menu'
import { RepositoryPathDialog } from './RepositoryPathDialog'

export interface RepositoryPickerProps {
  repositories: GitRepository[]
  savedRepositories: NonNullable<GitRepositoryList['savedRepositories']>
  repo: GitRepository | null
  disabled: boolean
  onSelectRepository: (root: string) => void
  onOpenRepository: (root: string) => Promise<GitFailure | null>
  onForgetRepository: (root: string) => Promise<GitFailure | null>
  compact?: boolean
  touch?: boolean
}

export function RepositoryPicker({ repositories, savedRepositories, repo, disabled, onSelectRepository, onOpenRepository, onForgetRepository, compact, touch }: RepositoryPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [pathDialog, setPathDialog] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const alive = useRef(true)
  const request = useRef(0)
  const busy = disabled || pending
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; request.current++ }
  }, [])

  const close = () => {
    request.current++
    setOpen(false)
    setError(null)
  }
  const showFailure = (failure: GitFailure) => setError(gitErrorMessage(failure, t))
  const openFolder = async () => {
    if (busy) return
    setError(null)
    if (api.isRemoteMode()) {
      setOpen(false)
      setPathDialog(true)
      return
    }
    const mine = ++request.current
    setPending(true)
    try {
      const picked = await api.selectFolder()
      if (!alive.current || mine !== request.current) return
      if (!picked.success) {
        setError(t('Could not open the folder picker. Try again.'))
        return
      }
      if (typeof picked.data !== 'string' || !picked.data) return
      const failure = await onOpenRepository(picked.data)
      if (!alive.current || mine !== request.current) return
      if (failure) setError(repositorySelectionError(failure, t))
      else close()
    } catch (cause) {
      console.warn('[ChangesView] Repository folder picker failed:', failureOf(cause))
      if (alive.current && mine === request.current) setError(t('Could not open the repository. Try again.'))
    } finally {
      if (alive.current) setPending(false)
    }
  }
  const forget = async (root: string) => {
    if (busy) return
    setPending(true)
    setError(null)
    const mine = ++request.current
    try {
      const failure = await onForgetRepository(root)
      if (!alive.current || mine !== request.current) return
      if (failure) showFailure(failure)
      else close()
    } catch (cause) {
      console.warn('[ChangesView] Could not remove remembered repository:', failureOf(cause))
      if (alive.current && mine === request.current) setError(t('Could not remove the repository from the list. Try again.'))
    } finally {
      if (alive.current) setPending(false)
    }
  }
  const savedRoots = new Set(savedRepositories.map((item) => item.root))
  const availableRoots = new Set(repositories.map((item) => item.root))
  const removal = (root: string) => (
    <MenuItem disabled={busy} onSelect={() => void forget(root)} description={t('No files will be deleted.')}>
      {t('Remove from list')}
    </MenuItem>
  )
  const branch = repo?.branch ?? (repo?.head ? t('Detached at {{commit}}', { commit: repo.head }) : t('No commits yet'))

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={busy}
        onClick={() => { setError(null); setOpen((value) => !value) }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={repo ? t('Repository: {{name}}', { name: repo.name }) : t('Open repository…')}
        title={repo?.root}
        className={`inline-flex min-w-0 max-w-[220px] shrink-[0.3] items-center gap-1.5 rounded-sm px-1.5 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 ${touch ? 'h-10' : 'h-10 sm:h-7'}`}
      >
        {!compact && <BookMarked size={14} className="shrink-0 text-faint-foreground" aria-hidden />}
        <span className="truncate font-semibold text-foreground">{repo?.name ?? t('Open repository…')}</span>
        {repo && !compact && <span className="hidden truncate text-[12px] text-subtle-foreground min-[460px]:inline">{branch}</span>}
        <ChevronDown size={12} className="shrink-0" aria-hidden />
      </button>
      <Menu open={open} onClose={close} anchorRef={anchorRef} label={t('Repositories in this space')} className="[&_[role^=menuitem]]:min-h-10 [&_[role^=menuitem]]:sm:min-h-8">
        <MenuLabel>{t('Repositories in this space')}</MenuLabel>
        {repositories.map((item) => (
          <div key={item.root} role="group" aria-label={item.root}>
            <MenuItem
              checked={item.root === repo?.root}
              disabled={busy}
              description={<span className="break-all">{item.root}</span>}
              onSelect={() => { close(); onSelectRepository(item.root) }}
            >{item.name}</MenuItem>
            {savedRoots.has(item.root) && removal(item.root)}
          </div>
        ))}
        {savedRepositories.filter((item) => !availableRoots.has(item.root)).map((item) => (
          <div key={item.root} role="group" aria-label={item.root}>
            <MenuItem disabled onSelect={() => {}} description={<span className="break-all">{item.root}</span>}>
              {t('Unavailable')}
            </MenuItem>
            {removal(item.root)}
          </div>
        ))}
        <MenuSeparator />
        <MenuItem disabled={busy} icon={<FolderOpen size={14} />} onSelect={() => void openFolder()}>{t('Open repository…')}</MenuItem>
        <MenuNote>{t('Choose the repository folder itself, not a parent folder.')}</MenuNote>
        {error && <p role="alert" className="break-words px-2 py-2 text-xs text-destructive">{error}</p>}
      </Menu>
      {pathDialog && (
        <RepositoryPathDialog
          disabled={disabled}
          opener={anchorRef}
          onOpen={onOpenRepository}
          onClose={() => setPathDialog(false)}
        />
      )}
    </>
  )
}
