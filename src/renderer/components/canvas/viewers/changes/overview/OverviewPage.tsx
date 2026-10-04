/**
 * "Overview & review": the change at a glance — key numbers and where the
 * lines changed, by folder (computed from the list, no AI) — beside the AI
 * review card. A folder opens its detail page.
 */

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FolderTree } from 'lucide-react'
import { useTranslation } from '../../../../../i18n'
import { areaHasHeading, computeDistribution, dirLabel, type DirectoryStats } from './distribution'
import { DiffStat, PathTail } from '../shared/parts'
import { flashElement } from '../shared/flash'
import { formatCount } from '../shared/format'
import { OVERVIEW_KPI_ROW_WIDTH, OVERVIEW_TWO_COLUMNS_WIDTH } from '../shared/use-container-width'
import type { ViewFile } from '../model/view-files'

/** Folders listed per area until the user asks for the rest: a vendored tree can hold thousands. */
const AREA_ROWS = 8

interface OverviewPageProps {
  /** Width of the page (the view less a docked file list), for its columns: the canvas can be narrow on a wide window. */
  width: number
  /** Files after the filter and "hide generated". */
  shown: readonly ViewFile[]
  hiddenGenerated: number
  initialScroll: number
  onScroll: (top: number) => void
  /** Folder whose detail page was just left: brought into view and pointed at. */
  returnedFrom: string | null
  onOpenDirectory: (dir: string, order: string[]) => void
  review: ReactNode
}

export function OverviewPage({ width, shown, hiddenGenerated, initialScroll, onScroll, returnedFrom, onOpenDirectory, review }: OverviewPageProps) {
  const { t, i18n } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const distribution = useMemo(() => computeDistribution(shown), [shown])
  const lang = i18n.language
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = initialScroll
    // Restored once, when the page appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (returnedFrom === null) return
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-dir="${CSS.escape(returnedFrom)}"]`)
    if (!row) return
    const box = scrollRef.current!.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    if (rect.top < box.top || rect.bottom > box.bottom) row.scrollIntoView({ block: 'center' })
    row.focus({ preventScroll: true })
    return flashElement(row)
  }, [returnedFrom])

  const kpis: Array<{ value: ReactNode; label: string; note?: string }> = [
    {
      value: formatCount(distribution.files, lang),
      label: t('Files'),
      note: hiddenGenerated > 0 ? t('{{count}} generated hidden', { count: hiddenGenerated }) : undefined,
    },
    {
      value: formatCount(distribution.dirs, lang),
      label: t('Folders'),
      note: t('{{count}} top-level areas', { count: distribution.areas.length }),
    },
    {
      value: <DiffStat additions={distribution.additions} deletions={distribution.deletions} className="!text-[17px]" />,
      label: t('Lines changed'),
    },
    { value: formatCount(distribution.newFiles, lang), label: t('New files') },
  ]

  return (
    <div
      ref={scrollRef}
      data-overview-scroll
      onScroll={(e) => onScroll(e.currentTarget.scrollTop)}
      className="h-full overflow-y-auto overscroll-contain"
    >
      <div className="mx-auto flex max-w-[1180px] flex-col gap-3 p-3 pb-20 sm:p-4">
        <div className={`grid gap-2 ${width === 0 || width >= OVERVIEW_KPI_ROW_WIDTH ? 'grid-cols-4' : 'grid-cols-2'}`}>
          {kpis.map((kpi) => (
            <div key={kpi.label} className="rounded-lg border border-border bg-card px-3 py-2.5">
              <div className="text-[19px] font-semibold leading-tight text-foreground">{kpi.value}</div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">
                {kpi.label}
                {kpi.note && <span className="text-subtle-foreground"> · {kpi.note}</span>}
              </div>
            </div>
          ))}
        </div>

        <div className={`grid gap-3 ${width >= OVERVIEW_TWO_COLUMNS_WIDTH ? 'grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]' : 'grid-cols-1'}`}>
          <section className="min-w-0 rounded-lg border border-border bg-card p-3" aria-labelledby="changes-by-folder">
            <h3 id="changes-by-folder" className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[13px] font-semibold text-foreground">
              <span className="inline-flex items-center gap-1.5"><FolderTree size={14} className="text-faint-foreground" aria-hidden />{t('Changes by folder')}</span>
              <span className="text-[12px] font-normal text-subtle-foreground">{t('Grouped by path · bar length = lines changed')}</span>
            </h3>
            {/* One grid for every row, so the bars line up; the bar gives way to the names in a narrow column. */}
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(36px,min(140px,25%))_auto] gap-x-2">
              {distribution.areas.map((area, index) => {
                // The folder just left stays listed, so it can be pointed at.
                const all = expanded.has(area.area) || area.dirs.slice(AREA_ROWS).some((dir) => dir.dir === returnedFrom)
                const rows = all ? area.dirs : area.dirs.slice(0, AREA_ROWS)
                const rest = area.dirs.length - rows.length
                const headed = areaHasHeading(area)
                // A folder alone in its area names itself; a run of those reads as one group.
                const gap = index > 0 && !headed && areaHasHeading(distribution.areas[index - 1])
                return (
                  <Fragment key={area.area || '/'}>
                    {headed ? (
                      <div className={`col-span-3 px-1.5 pb-0.5 text-[11px] text-subtle-foreground ${index === 0 ? 'pt-1' : 'pt-3'}`}>
                        {area.area}
                      </div>
                    ) : gap && <div className="col-span-3 pt-2" aria-hidden />}
                    {rows.map((dir) => (
                      <DirectoryRow
                        key={dir.dir}
                        dir={dir}
                        label={dir.dir === '' ? t('(repository root)') : dirLabel(dir.dir, area)}
                        max={distribution.maxDirLines}
                        onOpen={() => onOpenDirectory(dir.dir, distribution.order)}
                      />
                    ))}
                    {rest > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpanded((current) => new Set(current).add(area.area))}
                        className="col-span-3 h-7 rounded-md px-1.5 text-left text-[12px] text-primary hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                      >
                        {t('Show {{count}} more folders', { count: rest })}
                      </button>
                    )}
                  </Fragment>
                )
              })}
            </div>
          </section>
          <div className="min-w-0">{review}</div>
        </div>
      </div>
    </div>
  )
}

function DirectoryRow({ dir, label, max, onOpen }: { dir: DirectoryStats; label: string; max: number; onOpen: () => void }) {
  const { t, i18n } = useTranslation()
  const addWidth = max > 0 ? (dir.additions / max) * 100 : 0
  const delWidth = max > 0 ? (dir.deletions / max) * 100 : 0
  return (
    <button
      type="button"
      data-dir={dir.dir}
      onClick={onOpen}
      title={t('View changes in this folder')}
      className="col-span-3 grid h-7 grid-cols-subgrid items-center rounded-md px-1.5 text-left transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {/* The root's name is ordinary text. */}
        {dir.dir === ''
          ? <span className="truncate text-[12.5px] text-foreground">{label}</span>
          : <PathTail path={label} className="text-[12.5px] text-foreground" />}
        {dir.newFiles > 0 && (
          <span className="shrink-0 rounded bg-secondary px-1 text-[10.5px] text-muted-foreground">{t('+{{count}} new', { count: dir.newFiles })}</span>
        )}
      </span>
      <span className="flex h-2 overflow-hidden rounded-full bg-secondary" aria-hidden>
        <span className="h-full bg-diff-add" style={{ width: `${addWidth}%` }} />
        <span className="h-full bg-diff-del" style={{ width: `${delWidth}%` }} />
      </span>
      <span className="whitespace-nowrap text-right font-mono text-[11.5px]">
        <span className="text-muted-foreground">{formatCount(dir.files, i18n.language)}</span>
        <span className="text-subtle-foreground"> · </span>
        <DiffStat additions={dir.additions} deletions={dir.deletions} binary={dir.textFiles === 0} />
      </span>
    </button>
  )
}
