import { useId, useMemo, useState } from 'react'
import { hasUsableSubagentGroup, listSubagentSourceModels } from '../../../shared/subagent-models'
import type { AISourcesConfig } from '../../../shared/types/ai-sources'
import type { SubagentModelTarget } from '../../../shared/types/subagent-models'
import { useTranslation } from '../../i18n'
import { AccountModelList, AccountModelSection, ModelChoice } from '../ai-config/AccountModelList'
import { accountSearchText, filterAccountModels, modelSearchWords } from '../ai-config/account-model-search'
import { targetKey, targetLabel } from './model-presentation'

export function TargetPicker({ config, value, onChange, immediate = false }: {
  config: AISourcesConfig
  value?: SubagentModelTarget
  onChange: (target: SubagentModelTarget) => void
  immediate?: boolean
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const id = useId()
  const words = useMemo(() => modelSearchWords(query), [query])
  const catalog = useMemo(() => config.sources.flatMap(source => {
    const models = listSubagentSourceModels(source)
    return models.length ? [{ source, models, text: accountSearchText(source) }] : []
  }), [config.sources])
  const accounts = useMemo(() => catalog
    .map(({ source, models, text }) => ({ source, models: filterAccountModels(models, text, words) }))
    .filter(account => account.models.length > 0), [catalog, words])
  const availableGroups = useMemo(() => (config.groups ?? []).filter(group => hasUsableSubagentGroup(group, config.sources)), [config.groups, config.sources])
  const groups = useMemo(() => availableGroups.filter(group => words.every(word => group.name.toLocaleLowerCase().includes(word))), [availableGroups, words])
  const selected = value && targetKey(value)

  return (
    <div role={immediate ? 'group' : 'radiogroup'} aria-label={t('Account and model')} className="space-y-2">
      {!immediate && value && <p className="break-words text-sm text-foreground">{targetLabel(value, config, t)}</p>}
      <AccountModelList query={query} onSearch={setQuery} searchLabel={availableGroups.length ? t('Search accounts, models and groups') : t('Search accounts and models')}>
        {accounts.map(({ source, models }) => (
          <AccountModelSection
            key={source.id}
            source={source}
            models={models}
            initiallyExpanded={catalog.length === 1 || (value?.kind === 'model' && value.sourceId === source.id)}
            searching={words.length > 0}
            renderModel={model => {
              const target: SubagentModelTarget = { kind: 'model', sourceId: source.id, modelId: model.id }
              return <ModelChoice key={model.id} kind={immediate ? 'action' : 'radio'} name={id} label={model.name || model.id} checked={selected === targetKey(target)} onChange={() => onChange(target)} />
            }}
          />
        ))}
        {groups.length > 0 && (
          <div className={accounts.length ? 'border-t border-border-faint' : undefined}>
            <div className="px-3 pt-2 text-xs text-muted-foreground">{t('Load-Balancing Groups')}</div>
            {groups.map(group => {
              const target: SubagentModelTarget = { kind: 'group', groupId: group.id }
              return <ModelChoice key={group.id} kind={immediate ? 'action' : 'radio'} name={id} label={group.name} checked={selected === targetKey(target)} onChange={() => onChange(target)} nested={false} />
            })}
          </div>
        )}
        {!accounts.length && !groups.length && <p className="px-3 py-4 text-sm text-muted-foreground">{t('Nothing matches your search.')}</p>}
      </AccountModelList>
    </div>
  )
}
