/**
 * Turning a provider's catalog into stored model entries, and recording what a
 * fresh catalog changed for the people using an account. Pure; providers
 * include closed-source plug-ins, so whatever they report about presentation
 * is checked here before it is stored or shown.
 */

import type {
  AISource,
  ModelGroup,
  ModelOption,
  ModelPresentation,
  WithdrawnModel
} from '../../../shared/types'
import type { CatalogModelCapability, ModelCapabilityOverride } from '../../../shared/types/model-capabilities'

/** The per-model maps a provider reports, keyed by model id (login `_`-prefixed fields use the same shapes). */
export interface CatalogMaps {
  modelNames?: Record<string, string>
  modelCapabilities?: Record<string, CatalogModelCapability | undefined>
  modelVision?: Record<string, boolean>
  modelPresentation?: Record<string, unknown>
}

/**
 * Some providers still report server limits in the shape of the user's
 * `modelOverrides`. That map belongs to the user alone, so the server values are
 * read as catalog data instead; maps the provider states explicitly win.
 */
export function withLegacyCatalogOverrides(
  maps: CatalogMaps,
  legacy: Record<string, ModelCapabilityOverride> | undefined
): CatalogMaps {
  if (!legacy || typeof legacy !== 'object') return maps
  const modelNames = { ...maps.modelNames }
  const modelCapabilities = { ...maps.modelCapabilities }
  const modelVision = { ...maps.modelVision }
  for (const [id, entry] of Object.entries(legacy)) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.displayName === 'string' && entry.displayName && !modelNames[id]) modelNames[id] = entry.displayName
    if (!modelCapabilities[id]) {
      const capability: CatalogModelCapability = {}
      if (typeof entry.contextWindow === 'number') capability.contextWindow = entry.contextWindow
      if (typeof entry.maxOutputTokens === 'number') capability.maxOutputTokens = entry.maxOutputTokens
      if (Object.keys(capability).length) modelCapabilities[id] = capability
    }
    if (typeof entry.vision === 'boolean' && typeof modelVision[id] !== 'boolean') modelVision[id] = entry.vision
  }
  return { ...maps, modelNames, modelCapabilities, modelVision }
}

/**
 * The user's overrides without the fields an earlier refresh copied from the
 * server: a field equal to what the server reports now changes nothing the
 * user sees, while leaving it would flag an untouched model as edited.
 * Runs on every refresh that stores a catalog, a reconciled fallback included.
 */
export function withoutServerValues(
  overrides: AISource['modelOverrides'],
  models: ModelOption[]
): AISource['modelOverrides'] {
  if (!overrides || !models.length) return overrides
  const server = new Map(models.map(model => [model.id, {
    displayName: model.name,
    ...model.capabilities,
    ...(typeof model.supportsVision === 'boolean' ? { vision: model.supportsVision } : {})
  } as Record<string, unknown>]))
  let changed = false
  const next: NonNullable<AISource['modelOverrides']> = {}
  for (const [id, entry] of Object.entries(overrides)) {
    const reported = server.get(id)
    if (!reported || !entry || typeof entry !== 'object') {
      next[id] = entry
      continue
    }
    const kept = Object.fromEntries(Object.entries(entry).filter(([key, value]) => reported[key] !== value))
    if (Object.keys(kept).length !== Object.keys(entry).length) changed = true
    if (Object.keys(kept).length) next[id] = kept as ModelCapabilityOverride
  }
  return changed ? next : overrides
}

const MODEL_GROUPS: readonly ModelGroup[] = ['enterprise']
const BADGE_LABEL_MAX = 24
const BADGE_DETAIL_MAX = 200
/** Enough to cover months of vendor changes; older entries no longer matter to anyone. */
const MAX_WITHDRAWN_MODELS = 50

function shortText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text && text.length <= max ? text : undefined
}

function multiplier(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Only well-formed fields survive; anything else is dropped rather than shown. */
export function sanitizePresentation(value: unknown): ModelPresentation {
  if (typeof value !== 'object' || value === null) return {}
  const raw = value as Record<string, unknown>
  const result: ModelPresentation = {}
  if (MODEL_GROUPS.includes(raw.group as ModelGroup)) result.group = raw.group as ModelGroup
  const badge = raw.badge as Record<string, unknown> | undefined
  const label = shortText(badge?.label, BADGE_LABEL_MAX)
  if (label) {
    const detail = shortText(badge?.detail, BADGE_DETAIL_MAX)
    result.badge = detail ? { label, detail } : { label }
  }
  const cost = multiplier(raw.costMultiplier)
  if (cost !== undefined) {
    result.costMultiplier = cost
    const regular = multiplier(raw.regularCostMultiplier)
    if (regular !== undefined && regular !== cost) result.regularCostMultiplier = regular
  }
  return result
}

export function catalogModel(id: string, maps: CatalogMaps): ModelOption {
  const capabilities = maps.modelCapabilities?.[id]
  const vision = maps.modelVision?.[id]
  return {
    id,
    name: maps.modelNames?.[id] || id,
    ...(capabilities ? { capabilities } : {}),
    ...(typeof vision === 'boolean' ? { supportsVision: vision } : {}),
    ...sanitizePresentation(maps.modelPresentation?.[id])
  }
}

/** The presentation of stored entries, in the shape providers report it. */
export function presentationMap(models: ModelOption[]): Record<string, ModelPresentation> {
  const map: Record<string, ModelPresentation> = {}
  for (const model of models) {
    const presentation = sanitizePresentation(model)
    if (Object.keys(presentation).length) map[model.id] = presentation
  }
  return map
}

/**
 * Apply only to a list that came from the vendor, never to a fallback served
 * while the vendor was unreachable: which models it stopped listing, and
 * whether the account's own model had to move.
 */
export function recordCatalogChange(previous: AISource, next: AISource, at: string): AISource {
  const previousModels = previous.availableModels ?? []
  const nextModels = next.availableModels ?? []
  const listed = new Set(nextModels.map(model => model.id))
  const dropped: WithdrawnModel[] = previousModels
    .filter(model => !listed.has(model.id))
    .map(model => ({ id: model.id, name: model.name || model.id, at }))
  const kept = (previous.withdrawnModels ?? [])
    .filter(model => !listed.has(model.id) && !dropped.some(entry => entry.id === model.id))
  const withdrawnModels = [...dropped, ...kept].slice(0, MAX_WITHDRAWN_MODELS)

  const result: AISource = { ...next, withdrawnModels: withdrawnModels.length ? withdrawnModels : undefined }
  if (previous.model && previous.model !== next.model && !listed.has(previous.model)) {
    // An earlier sign-in may already have moved the model into the withdrawn list.
    const fromName = previousModels.find(model => model.id === previous.model)?.name
      || previous.withdrawnModels?.find(model => model.id === previous.model)?.name
      || previous.model
    const toName = nextModels.find(model => model.id === next.model)?.name || next.model
    // A model re-issued under a new id keeps its name; to the user nothing moved.
    result.modelReplacement = fromName === toName
      ? undefined
      : { from: previous.model, fromName, to: next.model, at }
  }
  return result
}
