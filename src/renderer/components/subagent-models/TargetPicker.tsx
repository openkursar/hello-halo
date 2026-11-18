import { useId, useMemo, useState } from 'react'
import { listSourceModels } from '../../../shared/ai-groups'
import { getSourceAccountName, type AISourcesConfig } from '../../../shared/types/ai-sources'
import type { SubagentModelTarget } from '../../../shared/types/subagent-models'
import { useTranslation } from '../../i18n'
import { targetKey, targetLabel } from './model-presentation'

const PAGE_SIZE = 30

export function TargetPicker({ config, value, onChange }: {
  config: AISourcesConfig
  value?: SubagentModelTarget
  onChange: (target: SubagentModelTarget) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const id = useId()
  const choices = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const items: Array<{ target: SubagentModelTarget; label: string }> = []
    for (const source of config.sources) {
      for (const model of listSourceModels(source)) {
        const target: SubagentModelTarget = { kind: 'model', sourceId: source.id, modelId: model.id }
        const account = getSourceAccountName(source)
        const label = `${source.name || source.provider}${account ? ` · ${account}` : ''} / ${model.name || model.id}`
        if (words.every(word => `${label} ${model.id}`.toLocaleLowerCase().includes(word))) items.push({ target, label })
      }
    }
    for (const group of config.groups ?? []) {
      if (words.every(word => group.name.toLocaleLowerCase().includes(word))) items.push({ target: { kind: 'group', groupId: group.id }, label: group.name })
    }
    return items
  }, [config.sources, config.groups, query])
  const lastPage = Math.max(0, Math.ceil(choices.length / PAGE_SIZE) - 1)
  const currentPage = Math.min(page, lastPage)
  return <div className="space-y-2">
    {value && <p className="break-words text-sm text-foreground">{targetLabel(value, config, t)}</p>}
    <label htmlFor={id} className="sr-only">{t('Search accounts, models and groups')}</label>
    <input id={id} type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} placeholder={t('Search accounts, models and groups')} className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
    <div role="radiogroup" aria-label={t('Account and model')} className="max-h-56 overflow-y-auto rounded-lg bg-secondary/40 p-1">
      {choices.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(item => <label key={targetKey(item.target)} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-secondary sm:min-h-9">
        <input type="radio" name={id} checked={!!value && targetKey(value) === targetKey(item.target)} onChange={() => onChange(item.target)} className="shrink-0 accent-primary" />
        <span className="min-w-0 break-words">{item.label}{item.target.kind === 'group' && <span className="ml-2 text-xs text-muted-foreground">{t('Load-balancing group')}</span>}</span>
      </label>)}
      {!choices.length && <p className="p-3 text-sm text-muted-foreground">{t('No matching accounts, models or groups. Add an AI provider in settings first.')}</p>}
    </div>
    {lastPage > 0 && <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)} className="min-h-11 rounded px-2 hover:bg-secondary disabled:opacity-40 sm:min-h-9">{t('Previous')}</button>
      <span>{t('Page {{page}} of {{count}}', { page: currentPage + 1, count: lastPage + 1 })}</span>
      <button type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)} className="min-h-11 rounded px-2 hover:bg-secondary disabled:opacity-40 sm:min-h-9">{t('Next')}</button>
    </div>}
  </div>
}
