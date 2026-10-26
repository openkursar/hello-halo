/**
 * Pieces every model picker shares: the vendor's grouping of a source's
 * models, the badge and credit multiplier beside a model's name, and the line
 * that says a model is no longer offered. Each part shows only what the
 * source's catalog reported, so a source without such data looks as before.
 */

import type { ReactNode } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import {
  activeModelReplacement,
  findWithdrawnModel,
  type AISource,
  type ModelGroup,
  type ModelOption
} from '../../types'
import { useTranslation } from '../../i18n'

export interface ModelSection {
  /** Absent for the vendor's own models. */
  group?: ModelGroup
  models: ModelOption[]
}

/** The vendor's own models first, in its order, then each group in the order it first appears. */
export function groupModels(models: ModelOption[]): ModelSection[] {
  const sections: ModelSection[] = [{ models: [] }]
  for (const model of models) {
    let section = sections.find(item => item.group === model.group)
    if (!section) {
      section = { group: model.group, models: [] }
      sections.push(section)
    }
    section.models.push(model)
  }
  return sections.filter(section => section.models.length > 0)
}

/** Multipliers as vendors print them: 1x, 0.5x, 0.69x. */
export function formatCostMultiplier(value: number): string {
  return `${+value.toFixed(2)}x`
}

export function useModelGroupLabel(): (group: ModelGroup) => string {
  const { t } = useTranslation()
  return group => {
    switch (group) {
      case 'enterprise': return t('Enterprise models')
    }
  }
}

export function ModelGroupHeading({ group, className = '' }: { group: ModelGroup; className?: string }) {
  const label = useModelGroupLabel()
  return (
    <div className={`pt-2 pb-1 text-[11px] font-medium text-subtle-foreground ${className}`}>
      {label(group)}
    </div>
  )
}

export function ModelBadgePill({ model }: { model: ModelOption }) {
  if (!model.badge) return null
  return (
    <span
      title={model.badge.detail}
      className="shrink-0 whitespace-nowrap rounded-sm bg-primary/10 px-1 text-[10px] font-medium leading-4 text-primary"
    >
      {model.badge.label}
    </span>
  )
}

/** `className` carries the text color, so a caller can show the value in full strength. */
export function ModelCost({ model, className = 'text-muted-foreground' }: { model: ModelOption; className?: string }) {
  const { t } = useTranslation()
  if (model.costMultiplier === undefined) return null
  const regular = model.regularCostMultiplier
  return (
    <span
      title={t('Credits per use, relative to the base rate')}
      className={`shrink-0 whitespace-nowrap tabular-nums ${className}`}
    >
      {regular !== undefined && (
        <span className="mr-1 text-subtle-foreground line-through" title={t('Usually {{value}}', { value: formatCostMultiplier(regular) })}>
          {formatCostMultiplier(regular)}
        </span>
      )}
      {formatCostMultiplier(model.costMultiplier)}
    </span>
  )
}

/** A model's name with the vendor's badge and multiplier, for one picker row. */
export function ModelRowLabel({ model }: { model: ModelOption }) {
  return (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate">{model.name || model.id}</span>
        <ModelBadgePill model={model} />
      </span>
      <ModelCost model={model} className="text-[11px] text-muted-foreground" />
    </>
  )
}

/**
 * What one use of the current model costs and the vendor's note on its offer,
 * written out where a row's hover text cannot be read (the card, the phone
 * sheet). Nothing when the catalog reports neither.
 */
export function ModelOfferFacts({ model, className = '' }: { model: ModelOption | undefined; className?: string }) {
  const { t } = useTranslation()
  if (!model || (model.costMultiplier === undefined && !model.badge?.detail)) return null
  return (
    <div className={`space-y-1.5 text-xs ${className}`}>
      {model.costMultiplier !== undefined && (
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">{t('Credits per use')}</span>
          <ModelCost model={model} className="text-foreground" />
        </div>
      )}
      {model.badge?.detail && (
        <p className="text-[11px] leading-4 text-muted-foreground break-words">{model.badge.detail}</p>
      )}
    </div>
  )
}

/**
 * What changed about the model a selection runs on, if anything: the vendor
 * stopped offering it (it may stop working), or the account's own model was
 * replaced at a refresh. `modelId` is the model the selection runs on.
 */
export function ModelAvailabilityNotice({ source, modelId, withReplacement = true, className = '' }: {
  source: AISource
  modelId: string | undefined
  /** False where the selection names its own model: the account's replacement did not change it. */
  withReplacement?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const withdrawn = findWithdrawnModel(source, modelId)
  if (withdrawn) {
    // The vendor re-issued it under a new id: the same name is still in the list.
    const reissued = source.availableModels?.some(model => model.name === withdrawn.name)
    return (
      <ModelNotice tone="warning" className={className}>
        {reissued
          ? t('{{account}} updated {{model}}. Choose it again to use the current version.', { model: withdrawn.name, account: source.name })
          : t('{{model}} is no longer offered by {{account}}. Choose another model.', { model: withdrawn.name, account: source.name })}
      </ModelNotice>
    )
  }
  const replacement = withReplacement && modelId === source.model ? activeModelReplacement(source) : undefined
  if (!replacement) return null
  const to = source.availableModels?.find(model => model.id === replacement.to)?.name || replacement.to
  return (
    <ModelNotice className={className}>
      {t('{{from}} is no longer offered, so this account now uses {{to}}.', { from: replacement.fromName, to })}
    </ModelNotice>
  )
}

/** One short line under a picker: `warning` when the selection may stop working. */
export function ModelNotice({ tone = 'info', children, className = '' }: {
  tone?: 'info' | 'warning'
  children: ReactNode
  className?: string
}) {
  const Icon = tone === 'warning' ? AlertTriangle : Info
  return (
    <p
      className={`flex items-start gap-1.5 text-[11px] leading-4 ${
        tone === 'warning' ? 'text-halo-warning' : 'text-muted-foreground'
      } ${className}`}
    >
      <Icon className="mt-px h-3 w-3 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
}
