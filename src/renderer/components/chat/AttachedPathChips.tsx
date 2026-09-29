/**
 * Local files and folders attached to a message, shown by name.
 *
 * The full path is what the AI reads; the user sees the name, with the path on
 * hover. In the composer a chip can be removed; in the transcript a click
 * reveals the item in the system file manager (desktop only).
 */

import { FileText, Folder, X } from 'lucide-react'
import { attachedPathName, type AttachedPath } from '../../../shared/attached-paths'
import { api } from '../../api'
import { isElectron } from '../../api/transport'
import { useTranslation } from '../../i18n'

interface AttachedPathChipsProps {
  paths: AttachedPath[]
  /** Composer: each chip can be removed. */
  onRemove?: (path: string) => void
  className?: string
}

export function AttachedPathChips({ paths, onRemove, className = '' }: AttachedPathChipsProps) {
  const { t } = useTranslation()
  if (paths.length === 0) return null
  const canReveal = !onRemove && isElectron()

  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {paths.map((entry) => {
        const name = attachedPathName(entry.path)
        const Icon = entry.isDirectory ? Folder : FileText
        const body = (
          <>
            <Icon size={13} className="shrink-0 text-muted-foreground" />
            <span className="truncate">{name}</span>
          </>
        )
        return (
          <span
            key={entry.path}
            title={entry.path}
            className="group inline-flex max-w-[240px] items-center rounded-lg border border-border/70 bg-background/60
              text-[12.5px] leading-none text-foreground animate-fade-in"
          >
            {canReveal ? (
              <button
                type="button"
                onClick={() => void api.showArtifactInFolder(entry.path)}
                className="inline-flex min-w-0 items-center gap-1.5 h-7 px-2 rounded-lg hover:bg-secondary transition-colors"
              >
                {body}
              </button>
            ) : (
              <span className={`inline-flex min-w-0 items-center gap-1.5 h-7 ${onRemove ? 'pl-2 pr-0.5' : 'px-2'}`}>{body}</span>
            )}
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(entry.path)}
                aria-label={t('Remove')}
                className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground
                  hover:bg-secondary hover:text-foreground transition-colors
                  sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
              >
                <X size={12} />
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}
