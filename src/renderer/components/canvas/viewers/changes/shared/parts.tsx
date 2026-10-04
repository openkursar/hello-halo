/**
 * Small pieces the changes view repeats: icon buttons with a tooltip, the
 * +N −N count, the status letter, file icons.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { GitFileState } from '../../../../../../shared/types/git'
import { useTranslation } from '../../../../../i18n'
import { FileIcon } from '../../../../icons/ToolIcons'
import { extensionOf } from '../model/paths'
import { stateClass, stateLetter } from '../model/view-files'
import { formatCount } from './format'

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string
  /** Pressed state of a toggle. */
  pressed?: boolean
  size?: 'sm' | 'md'
  children: ReactNode
}

/** An icon-only button: its label is the accessible name and the tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, pressed, size = 'md', className = '', children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`inline-flex shrink-0 items-center justify-center rounded-sm transition-colors ease-halo focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default disabled:opacity-40 ${
        // Touch screens get finger-sized targets.
        size === 'sm' ? 'h-10 w-10 sm:h-6 sm:w-6' : 'h-10 w-10 sm:h-7 sm:w-7'
      } ${
        pressed ? 'bg-secondary text-foreground' : 'text-subtle-foreground hover:bg-secondary hover:text-foreground'
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
})

export function DiffStat({ additions, deletions, binary, className = '' }: {
  additions: number | null
  deletions: number | null
  binary?: boolean
  className?: string
}) {
  const { t, i18n } = useTranslation()
  if (binary) return <span className={`text-[11px] text-subtle-foreground ${className}`}>{t('Binary')}</span>
  if (additions === null && deletions === null) return null
  return (
    <span className={`whitespace-nowrap font-mono text-[11.5px] ${className}`}>
      <span className="text-diff-add">+{formatCount(additions ?? 0, i18n.language)}</span>{' '}
      <span className="text-diff-del">−{formatCount(deletions ?? 0, i18n.language)}</span>
    </span>
  )
}

export function stateName(state: GitFileState, t: (key: string) => string): string {
  switch (state) {
    case 'modified': return t('Modified')
    case 'added': return t('Added')
    case 'deleted': return t('Deleted')
    case 'renamed': return t('Renamed')
    case 'copied': return t('Copied')
    case 'type-changed': return t('Type changed')
    case 'untracked': return t('Untracked')
    case 'conflicted': return t('Conflicted')
  }
}

export function StateLetter({ state }: { state: GitFileState }) {
  const { t } = useTranslation()
  const name = stateName(state, t)
  return (
    <span title={name} className={`w-3.5 shrink-0 text-center font-mono text-[11px] font-semibold ${stateClass(state)}`}>
      <span aria-hidden>{stateLetter(state)}</span>
      <span className="sr-only">{name}</span>
    </span>
  )
}

export function FileGlyph({ path, size = 14 }: { path: string; size?: number }) {
  return <FileIcon extension={extensionOf(path)} size={size} className="shrink-0" />
}

/**
 * A path cut from the left when it does not fit, so its last segments stay in
 * view. The inner isolate keeps a leading '.' (`.github/…`) from moving to the end.
 */
export function PathTail({ path, className = '' }: { path: string; className?: string }) {
  return (
    <span className={`min-w-0 truncate font-mono [direction:rtl] text-left ${className}`}>
      <span dir="ltr">{path}</span>
    </span>
  )
}

/** A keyboard key as shown in hints. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border px-1 font-mono text-[10.5px] leading-[15px] text-subtle-foreground">
      {children}
    </kbd>
  )
}

export const isMacPlatform = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC')

/** A touch screen as the main pointer: keyboard shortcut hints are left out. */
export const isCoarsePointer = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
