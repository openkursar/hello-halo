/**
 * The file list beside the diffs: filter, tree or list, generated files
 * hidden or shown, groups with their actions, and whatever goes at the
 * bottom (the commit box). Rows are virtualized, so hundreds of files scroll
 * as smoothly as ten.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { ChevronDown, ChevronRight, Folder, RefreshCw, Search, X } from 'lucide-react'
import { useTranslation } from '../../../../../i18n'
import { buildPanelRows, dirRowKey, type PanelGroup, type PanelGroupId, type PanelRow } from './panel-rows'
import { DiffStat, FileGlyph, IconButton, PathTail, StateLetter } from '../shared/parts'
import { formatCount } from '../shared/format'
import { baseName, dirName } from '../model/paths'
import type { ViewFile } from '../model/view-files'

interface FilePanelProps {
  groups: PanelGroup[]
  /** Generated files left out of `groups`; 0 when none or when they are shown. */
  hiddenGenerated: number
  onShowGenerated: () => void
  filter: string
  onFilterChange: (filter: string) => void
  tree: boolean
  onTreeChange: (tree: boolean) => void
  hideGenerated: boolean
  onHideGeneratedChange: (hide: boolean) => void
  /** Off where generated files are not told apart (a reply's edits). */
  showGeneratedToggle?: boolean
  onRefresh?: () => void
  refreshing?: boolean
  currentKey: string | null
  onOpenFile: (file: ViewFile) => void
  rowActions?: (file: ViewFile, group: PanelGroupId) => ReactNode
  groupActions?: (group: PanelGroup) => ReactNode
  /** The list was cut at this many files. */
  truncatedAt?: number
  /** Always show row actions (touch screens, narrow drawers) instead of on hover. */
  touch: boolean
  /** The panel just opened as a drawer: the filter takes focus. */
  focusFilter?: boolean
  footer?: ReactNode
}

type FooterContext = Pick<FilePanelProps, 'hiddenGenerated' | 'onShowGenerated' | 'truncatedAt'>

// Module-level, so the footer keeps its identity (an inline component would remount every render).
const PANEL_COMPONENTS = {
  Footer: ({ context }: { context?: FooterContext }) => (context ? <PanelFooter {...context} /> : null),
}

export function FilePanel(props: FilePanelProps) {
  const { t } = useTranslation()
  const { groups, filter, onFilterChange, tree, onTreeChange, hideGenerated, onHideGeneratedChange, onRefresh, refreshing } = props
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const rows = useMemo(() => buildPanelRows(groups, { tree, collapsed }), [groups, tree, collapsed])
  const total = groups.reduce((sum, group) => sum + group.files.length, 0)
  const filterRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.focusFilter) filterRef.current?.focus()
    // Only when the panel appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const { hiddenGenerated, onShowGenerated, truncatedAt } = props
  const footer = useMemo<FooterContext>(() => ({ hiddenGenerated, onShowGenerated, truncatedAt }), [hiddenGenerated, onShowGenerated, truncatedAt])
  // Rows re-render when what they show changes, not whenever the view does.
  const { currentKey, touch, rowActions, groupActions, onOpenFile } = props
  const rowView = useMemo<RowView>(
    () => ({ groups, collapsed, onToggle: toggle, currentKey, tree, touch, rowActions, groupActions, onOpenFile }),
    [groups, collapsed, toggle, currentKey, tree, touch, rowActions, groupActions, onOpenFile]
  )
  const renderRow = useCallback((_index: number, row: PanelRow) => <PanelRowView row={row} view={rowView} />, [rowView])

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex flex-col gap-1.5 border-b border-border p-2">
        <label className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2 focus-within:border-primary">
          <Search size={13} className="shrink-0 text-faint-foreground" aria-hidden />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.preventDefault()
                e.stopPropagation()
                onFilterChange('')
              }
            }}
            placeholder={t('Filter files (e.g. src/**)')}
            aria-label={t('Filter files (e.g. src/**)')}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-subtle-foreground"
          />
          {filter && (
            <IconButton size="sm" label={t('Clear filter')} onClick={() => onFilterChange('')}>
              <X size={12} />
            </IconButton>
          )}
        </label>
        <div className="flex items-center gap-1">
          <div role="radiogroup" aria-label={t('File list')} className="flex items-center gap-1">
            <Chip on={tree} role="radio" onClick={() => onTreeChange(true)}>{t('Tree')}</Chip>
            <Chip on={!tree} role="radio" onClick={() => onTreeChange(false)}>{t('List')}</Chip>
          </div>
          {props.showGeneratedToggle !== false && (
            <>
              <span className="w-1" />
              <Chip
                on={hideGenerated}
                onClick={() => onHideGeneratedChange(!hideGenerated)}
                title={t('Hides lockfiles, minified files, snapshots and files marked linguist-generated in .gitattributes')}
              >
                {t('Hide generated')}
              </Chip>
            </>
          )}
          <span className="flex-1" />
          {onRefresh && (
            <IconButton size="sm" label={t('Refresh')} onClick={onRefresh} disabled={refreshing}>
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            </IconButton>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {total === 0 && filter ? (
          <div className="flex flex-col items-start gap-2 p-3 text-[13px] text-subtle-foreground">
            {t('No matching files')}
            <button type="button" onClick={() => onFilterChange('')} className="text-primary hover:underline">
              {t('Clear filter')}
            </button>
          </div>
        ) : (
          <Virtuoso
            className="h-full"
            data={rows}
            context={footer}
            computeItemKey={(_index, row) => rowKey(row)}
            components={PANEL_COMPONENTS}
            itemContent={renderRow}
          />
        )}
      </div>

      {props.footer}
    </div>
  )
}

function rowKey(row: PanelRow): string {
  if (row.kind === 'group') return `g:${row.group}`
  if (row.kind === 'dir') return `d:${row.group}:${row.dir}`
  return `f:${row.group}:${row.file.key}`
}

function PanelFooter({ hiddenGenerated, onShowGenerated, truncatedAt }: FooterContext) {
  const { t, i18n } = useTranslation()
  return (
    <div className="flex flex-col gap-1.5 px-2 pb-3 pt-1">
      {truncatedAt !== undefined && (
        <p className="px-1 text-[12px] text-subtle-foreground">{t('Showing the first {{files}} files', { count: truncatedAt, files: formatCount(truncatedAt, i18n.language) })}</p>
      )}
      {hiddenGenerated > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-[12px] text-subtle-foreground">
          <span className="min-w-0 flex-1">{t('{{count}} generated files hidden', { count: hiddenGenerated })}</span>
          <button type="button" onClick={onShowGenerated} className="shrink-0 font-medium text-primary hover:underline">
            {t('Show')}
          </button>
        </div>
      )}
    </div>
  )
}

function groupTitle(group: PanelGroupId, t: (key: string) => string): string {
  switch (group) {
    case 'conflicted': return t('Conflicts')
    case 'staged': return t('Staged changes')
    case 'unstaged':
    case 'changes': return t('Changes')
  }
}

/** What every row is rendered with besides itself. */
interface RowView {
  groups: PanelGroup[]
  collapsed: ReadonlySet<string>
  onToggle: (key: string) => void
  currentKey: string | null
  tree: boolean
  touch: boolean
  rowActions?: FilePanelProps['rowActions']
  groupActions?: FilePanelProps['groupActions']
  onOpenFile: (file: ViewFile) => void
}

function PanelRowView({ row, view }: { row: PanelRow; view: RowView }) {
  const { t } = useTranslation()
  const { collapsed, onToggle } = view

  if (row.kind === 'group') {
    const group = view.groups.find((g) => g.id === row.group)!
    return (
      <div className="group/grp">
        <div className={`flex items-center gap-1 px-2 ${view.touch ? 'h-10' : 'h-8 pt-1'}`}>
          <button
            type="button"
            onClick={() => onToggle(row.group)}
            aria-expanded={!row.collapsed}
            className="flex min-w-0 flex-1 items-center gap-1 self-stretch rounded-sm text-left text-[12px] font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {row.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <span className="truncate">{groupTitle(row.group, t)}</span>
          </button>
          <span className={`items-center gap-0.5 ${view.touch ? 'flex' : 'hidden group-hover/grp:flex group-focus-within/grp:flex'}`}>
            {view.groupActions?.(group)}
          </span>
          <span className={`rounded-full bg-secondary px-1.5 text-[11px] font-medium text-muted-foreground ${view.touch ? '' : 'group-hover/grp:hidden group-focus-within/grp:hidden'}`}>
            {row.count}
          </span>
        </div>
        {row.group === 'conflicted' && !row.collapsed && (
          <p className="px-3 pb-1 text-[12px] text-subtle-foreground">{t('Resolve these in a terminal, or ask the AI to.')}</p>
        )}
      </div>
    )
  }

  if (row.kind === 'dir') {
    const key = dirRowKey(row.group, row.dir)
    return (
      <button
        type="button"
        onClick={() => onToggle(key)}
        aria-expanded={!collapsed.has(key)}
        title={row.dir}
        className={`flex w-full items-center gap-1 px-2.5 text-left text-subtle-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 ${view.touch ? 'h-10' : 'h-6'}`}
      >
        {row.collapsed ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
        <Folder size={13} className="shrink-0 text-faint-foreground" aria-hidden />
        <PathTail path={row.dir} className="text-[11.5px]" />
      </button>
    )
  }

  const { file } = row
  const current = view.currentKey === file.key
  const actions = view.rowActions?.(file, row.group)
  return (
    <div
      className={`group/row relative flex items-center gap-1.5 pr-1.5 ${view.touch ? 'h-10' : 'h-[26px]'} ${row.nested ? 'pl-7' : 'pl-2.5'} ${
        current ? 'bg-primary/15' : 'hover:bg-secondary'
      }`}
    >
      <button
        type="button"
        onClick={() => view.onOpenFile(file)}
        aria-current={current || undefined}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
      >
        <FileGlyph path={file.path} size={14} />
        <span className="shrink-0 truncate text-[13px] text-foreground [max-width:70%]">{baseName(file.path)}</span>
        {!view.tree && dirName(file.path) && (
          <PathTail path={dirName(file.path)} className="flex-1 text-[11px] text-subtle-foreground" />
        )}
      </button>
      {actions && (
        <span className={`items-center gap-px ${view.touch ? 'flex' : 'hidden group-hover/row:flex group-focus-within/row:flex'}`}>
          {actions}
        </span>
      )}
      {!view.touch && (
        <DiffStat
          additions={file.additions}
          deletions={file.deletions}
          binary={file.binary}
          className={actions ? 'group-hover/row:hidden group-focus-within/row:hidden' : ''}
        />
      )}
      <StateLetter state={file.state} />
    </div>
  )
}

function Chip({ on, onClick, title, role, children }: {
  on: boolean
  onClick: () => void
  title?: string
  role?: 'radio'
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'radio' ? on : undefined}
      aria-pressed={role ? undefined : on}
      title={title}
      onClick={onClick}
      className={`inline-flex h-[22px] items-center rounded-md border px-2 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
        on ? 'border-primary/50 bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
