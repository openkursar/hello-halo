/**
 * The panel that adds models to a group: accounts, each opening to its models,
 * with a search across both. Accounts that cannot be part of a group stay in
 * the list and say why, so nobody wonders where an account went.
 */

import { useMemo, useState } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { getSourceAccountName, type AIGroupMember, type AISource } from '../../types'
import { groupMemberKey } from '../../../shared/ai-groups'
import { pickerAccounts, type PickerAccount } from './group-editor-model'
import { describeUnusable } from './group-text'

/** Models drawn per account at once; a search narrows the rest. */
const MAX_ROWS_PER_ACCOUNT = 100

interface GroupModelPickerProps {
  sources: readonly AISource[]
  /** Keys of the models the group already holds. */
  taken: ReadonlySet<string>
  /** How many more models the group can take. */
  room: number
  onAdd: (members: AIGroupMember[]) => void
  onClose: () => void
}

function AccountSection({ account, expanded, onToggle, taken, picked, full, onPick }: {
  account: PickerAccount
  expanded: boolean
  onToggle: () => void
  taken: ReadonlySet<string>
  picked: ReadonlyMap<string, AIGroupMember>
  full: boolean
  onPick: (member: AIGroupMember, checked: boolean) => void
}) {
  const { t } = useTranslation()
  const { source, unusable, models } = account
  const person = getSourceAccountName(source)
  const name = source.name || source.provider

  if (unusable) {
    return (
      <div className="px-3 py-2 opacity-70">
        <div className="truncate text-sm text-foreground">{name}</div>
        <div className="text-xs text-muted-foreground">{describeUnusable(unusable, t)}</div>
      </div>
    )
  }

  const shown = models.slice(0, MAX_ROWS_PER_ACCOUNT)
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm hover:bg-secondary transition-colors"
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">{name}</span>
          {person && <span className="text-subtle-foreground"> · {person}</span>}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{models.length}</span>
      </button>
      {expanded && (
        <div className="pb-1">
          {shown.map(model => {
            const member = { sourceId: source.id, modelId: model.id }
            const key = groupMemberKey(member)
            const held = taken.has(key)
            const checked = held || picked.has(key)
            return (
              <label
                key={model.id}
                className={`flex min-h-11 items-center gap-2.5 py-1.5 pl-9 pr-3 text-sm sm:min-h-9 ${held ? 'opacity-60' : 'cursor-pointer hover:bg-secondary'}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={held || (!checked && full)}
                  onChange={event => onPick(member, event.target.checked)}
                  className="h-4 w-4 shrink-0 rounded border-border accent-primary"
                />
                <span className="min-w-0 flex-1 truncate text-foreground">{model.name || model.id}</span>
                {held && <span className="shrink-0 text-xs text-muted-foreground">{t('Added')}</span>}
              </label>
            )
          })}
          {models.length > shown.length && (
            <p className="py-1.5 pl-9 pr-3 text-xs text-muted-foreground">
              {t('Search to find the other models of this account.')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function GroupModelPicker({ sources, taken, room, onAdd, onClose }: GroupModelPickerProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(sources.length === 1 ? [sources[0].id] : []))
  const [picked, setPicked] = useState<ReadonlyMap<string, AIGroupMember>>(() => new Map())

  const accounts = useMemo(() => pickerAccounts(sources, query), [sources, query])
  const searching = query.trim().length > 0

  const toggle = (sourceId: string) => setOpen(previous => {
    const next = new Set(previous)
    if (!next.delete(sourceId)) next.add(sourceId)
    return next
  })
  const pick = (member: AIGroupMember, checked: boolean) => setPicked(previous => {
    const next = new Map(previous)
    if (checked) next.set(groupMemberKey(member), member)
    else next.delete(groupMemberKey(member))
    return next
  })

  const full = picked.size >= room
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border-faint p-2">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            // The panel sits inside the editor's form: Enter here searches, it does not save the group.
            onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }}
            placeholder={t('Search accounts and models')}
            aria-label={t('Search accounts and models')}
            className="w-full rounded-lg border border-border bg-input py-2 pl-8 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto py-1">
        {accounts.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{t('Nothing matches your search.')}</p>
        ) : accounts.map(account => (
          <AccountSection
            key={account.source.id}
            account={account}
            expanded={searching || open.has(account.source.id)}
            onToggle={() => toggle(account.source.id)}
            taken={taken}
            picked={picked}
            full={full}
            onPick={pick}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-faint p-2">
        <span className="min-w-0 text-xs text-muted-foreground">
          {picked.size > 0 ? t('{{count}} selected', { count: picked.size }) : ''}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:min-h-0"
          >
            {t('Cancel')}
          </button>
          <button
            type="button"
            disabled={picked.size === 0}
            onClick={() => onAdd([...picked.values()])}
            className="min-h-11 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
          >
            {t('Add')}
          </button>
        </div>
      </div>
    </div>
  )
}
