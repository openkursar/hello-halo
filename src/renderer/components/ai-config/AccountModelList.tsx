import { useId, useState, type ReactNode } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import { getSourceAccountName, type AISource, type ModelOption } from '../../../shared/types/ai-sources'
import { useTranslation } from '../../i18n'

const MAX_ROWS_PER_ACCOUNT = 100

export function AccountModelList({ query, onSearch, searchLabel, children, footer }: {
  query: string
  onSearch: (query: string) => void
  searchLabel: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card">
      <div className="border-b border-border-faint p-2">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={event => onSearch(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }}
            placeholder={searchLabel}
            aria-label={searchLabel}
            className="w-full rounded-lg border border-border bg-input py-2 pl-8 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto py-1">{children}</div>
      {footer && <div className="border-t border-border-faint p-2">{footer}</div>}
    </div>
  )
}

export function AccountModelSection({ source, models, initiallyExpanded, searching, unavailable, renderModel }: {
  source: AISource
  models: readonly ModelOption[]
  initiallyExpanded: boolean
  searching: boolean
  unavailable?: string
  renderModel: (model: ModelOption) => ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(initiallyExpanded)
  const [collapsedInSearch, setCollapsedInSearch] = useState(false)
  const id = useId()
  const person = getSourceAccountName(source)
  const name = source.name || source.provider

  if (unavailable) return (
    <div className="px-3 py-2 opacity-70">
      <div className="truncate text-sm text-foreground">{name}</div>
      <div className="text-xs text-muted-foreground">{unavailable}</div>
    </div>
  )

  const expanded = searching ? !collapsedInSearch : open
  return (
    <div>
      <button
        type="button"
        onClick={() => searching ? setCollapsedInSearch(!collapsedInSearch) : setOpen(!open)}
        aria-expanded={expanded}
        aria-controls={id}
        className="flex min-h-11 w-full items-center gap-1.5 px-3 py-2 text-left text-sm transition-colors hover:bg-secondary sm:min-h-9"
      >
        <ChevronRight aria-hidden className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">{name}</span>
          {person && <span className="text-subtle-foreground"> · {person}</span>}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{models.length}</span>
      </button>
      <div id={id} hidden={!expanded} className="pb-1">
        {expanded && models.slice(0, MAX_ROWS_PER_ACCOUNT).map(renderModel)}
        {expanded && models.length > MAX_ROWS_PER_ACCOUNT && (
          <p className="py-1.5 pl-9 pr-3 text-xs text-muted-foreground">{t('Search to find the other models of this account.')}</p>
        )}
      </div>
    </div>
  )
}

export function ModelChoice({ label, name, checked, disabled, note, onChange, kind, nested = true }: {
  label: string
  name?: string
  checked: boolean
  disabled?: boolean
  note?: string
  onChange: (checked: boolean) => void
  kind: 'checkbox' | 'radio'
  nested?: boolean
}) {
  const rowClass = `flex min-h-11 items-center gap-2.5 py-1.5 pr-3 text-sm focus-within:bg-secondary sm:min-h-9 ${nested ? 'pl-9' : 'pl-3'} ${disabled ? 'opacity-60' : 'cursor-pointer hover:bg-secondary'}`
  return (
    <label className={rowClass}>
      <input type={kind} name={name} aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="h-4 w-4 shrink-0 border-border accent-primary" />
      <span className="min-w-0 flex-1 truncate text-foreground" title={label}>{label}</span>
      {note && <span className="shrink-0 text-xs text-muted-foreground">{note}</span>}
    </label>
  )
}
