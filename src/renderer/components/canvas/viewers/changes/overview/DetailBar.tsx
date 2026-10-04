/**
 * Breadcrumb of the detail page opened from the overview: back to the
 * overview (Esc), where this item sits in the walk, previous / next (`[` `]`).
 */

import { useEffect, useRef } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useTranslation } from '../../../../../i18n'
import { Kbd } from '../shared/parts'
import { baseName, dirName } from '../model/paths'
import type { DetailState } from '../../../../../types/changes-view'

interface DetailBarProps {
  detail: DetailState
  fileCount: number
  /** The user just opened the page: focus goes to "back". Not when the tab is shown again. */
  takeFocus: boolean
  onBack: () => void
  onStep: (delta: number) => void
}

export function DetailBar({ detail, fileCount, takeFocus, onBack, onStep }: DetailBarProps) {
  const { t } = useTranslation()
  const backRef = useRef<HTMLButtonElement>(null)
  const item = detail.items[detail.index] ?? ''
  const position = detail.kind === 'dir'
    ? t('{{current}} of {{total}} · by lines changed', { current: detail.index + 1, total: detail.items.length })
    : t('{{current}} of {{total}} · files in the report', { current: detail.index + 1, total: detail.items.length })

  useEffect(() => {
    if (takeFocus) backRef.current?.focus({ preventScroll: true })
    // Only when the bar appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-2 sm:px-3">
      <button
        ref={backRef}
        type="button"
        onClick={onBack}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-sm pr-1.5 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ChevronLeft size={15} aria-hidden />
        <span className="hidden sm:inline">{t('Overview & review')}</span>
        <span className="sr-only sm:hidden">{t('Back')}</span>
      </button>
      <span className="text-subtle-foreground" aria-hidden>/</span>
      {detail.kind === 'dir' ? (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-mono text-[12.5px] font-semibold text-foreground" title={item || '/'}>{item || t('(repository root)')}</span>
          <span className="shrink-0 whitespace-nowrap text-[12px] text-subtle-foreground">· {t('{{count}} files', { count: fileCount })}</span>
        </span>
      ) : (
        <span className="min-w-0 truncate font-mono text-[12.5px]" title={item}>
          {dirName(item) && <span className="text-subtle-foreground">{dirName(item)}/</span>}
          <span className="font-semibold text-foreground">{baseName(item)}</span>
        </span>
      )}
      <span className="hidden shrink-0 whitespace-nowrap text-[12px] text-subtle-foreground md:inline">{position}</span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => onStep(-1)}
        disabled={detail.index === 0}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-[12.5px] text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="hidden sm:inline">{t('Previous')}</span><Kbd>[</Kbd>
      </button>
      <button
        type="button"
        onClick={() => onStep(1)}
        disabled={detail.index >= detail.items.length - 1}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-[12.5px] text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="hidden sm:inline">{t('Next')}</span><Kbd>]</Kbd>
      </button>
      <span className="hidden sm:inline" aria-hidden><Kbd>Esc</Kbd></span>
    </div>
  )
}
