import { useMemo, useState } from 'react'
import { useTranslation } from '../../i18n'
import type { AIGroupMember, AISource } from '../../types'
import { groupMemberKey } from '../../../shared/ai-groups'
import { AccountModelList, AccountModelSection, ModelChoice } from '../ai-config/AccountModelList'
import { pickerAccounts } from './group-editor-model'
import { describeUnusable } from './group-text'

interface GroupModelPickerProps {
  sources: readonly AISource[]
  taken: ReadonlySet<string>
  room: number
  onAdd: (members: AIGroupMember[]) => void
  onClose: () => void
}

export function GroupModelPicker({ sources, taken, room, onAdd, onClose }: GroupModelPickerProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<ReadonlyMap<string, AIGroupMember>>(() => new Map())
  const accounts = useMemo(() => pickerAccounts(sources, query), [sources, query])
  const searching = query.trim().length > 0
  const full = picked.size >= room

  const pick = (member: AIGroupMember, checked: boolean) => setPicked(previous => {
    const next = new Map(previous)
    if (checked) next.set(groupMemberKey(member), member)
    else next.delete(groupMemberKey(member))
    return next
  })

  return (
    <AccountModelList query={query} onSearch={setQuery} searchLabel={t('Search accounts and models')} footer={(
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-xs text-muted-foreground">{picked.size > 0 ? t('{{count}} selected', { count: picked.size }) : ''}</span>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:min-h-0">
            {t('Cancel')}
          </button>
          <button type="button" disabled={picked.size === 0} onClick={() => onAdd([...picked.values()])} className="min-h-11 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0">
            {t('Add')}
          </button>
        </div>
      </div>
    )}>
      {accounts.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">{t('Nothing matches your search.')}</p>
      ) : accounts.map(({ source, models, unusable }) => (
        <AccountModelSection
          key={source.id}
          source={source}
          models={models}
          searching={searching}
          initiallyExpanded={sources.length === 1}
          unavailable={unusable && describeUnusable(unusable, t)}
          renderModel={model => {
            const member = { sourceId: source.id, modelId: model.id }
            const key = groupMemberKey(member)
            const held = taken.has(key)
            const checked = held || picked.has(key)
            return <ModelChoice key={key} kind="checkbox" label={model.name || model.id} checked={checked} disabled={held || (!checked && full)} note={held ? t('Added') : undefined} onChange={value => pick(member, value)} />
          }}
        />
      ))}
    </AccountModelList>
  )
}
