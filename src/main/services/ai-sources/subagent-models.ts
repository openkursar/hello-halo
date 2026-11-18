import { randomUUID } from 'node:crypto'
import { getConfig, isConfigUnreadable, onAiSourcesConfigChange, saveConfig } from '../../foundation/config.service'
import { builtinSubagentModelId, emptySubagentModelSettings, findSubagentSourceModel, hasUsableSubagentGroup, isSubagentModelTarget, MODEL_SELECTION_LIMITS, normalizeSubagentModelName, projectSubagentModelSettings, SUBAGENT_MODEL_SLOTS, subagentModelName, validSubagentModelText } from '../../../shared/subagent-models'
import type { AISourcesConfig } from '../../../shared/types/ai-sources'
import type { SubagentModelInput, SubagentModelModeInput, SubagentModelProfile, SubagentModelRevisionInput, SubagentModelSettings, SubagentModelUpdate } from '../../../shared/types/subagent-models'

export class SubagentModelError extends Error {
  constructor(readonly code: string) { super(`Model assignment change rejected: ${code}`); this.name = 'SubagentModelError' }
}
function reject(code: string): never {
  console.warn(`[SubagentModels] Rejected configuration change: ${code}`)
  throw new SubagentModelError(code)
}
function sources(): AISourcesConfig {
  const value = getConfig().aiSources
  if (!value || value.version !== 2) reject('sources-unavailable')
  return value
}
export interface SubagentModelConfigurationSnapshot {
  settings?: SubagentModelSettings
  sources: readonly AISourcesConfig['sources'][number][]
  groups: readonly NonNullable<AISourcesConfig['groups']>[number][]
  revision: number
}
let snapshot: SubagentModelConfigurationSnapshot | undefined
let snapshotRevision = 0
function hasBoundTarget(profiles: readonly SubagentModelProfile[]): boolean {
  return profiles.some(profile => profile.target)
}
function replaceSnapshot(config: AISourcesConfig | undefined): void {
  const settings = config?.subagentModels
  snapshot = config ? {
    settings: settings && hasBoundTarget(settings.profiles) ? settings : undefined,
    sources: config.sources,
    groups: config.groups ?? [],
    revision: ++snapshotRevision,
  } : undefined
}
onAiSourcesConfigChange(replaceSnapshot)
export function seedSubagentModelSettings(config: AISourcesConfig | undefined): void {
  if (!snapshot || !config) replaceSnapshot(config)
}
export function getSubagentModelConfigurationSnapshot(): SubagentModelConfigurationSnapshot | undefined { return snapshot }
export function getSubagentModelSettings(): SubagentModelSettings | undefined { return snapshot?.settings }
export function getSubagentModelProfile(id: string): SubagentModelProfile | undefined { return getSubagentModelSettings()?.profiles.find(profile => profile.id === id) }
export function listSubagentModels(): SubagentModelSettings { return projectSubagentModelSettings(getConfig().aiSources?.subagentModels) }

function persist(config: AISourcesConfig, settings: SubagentModelSettings): SubagentModelSettings {
  if (Buffer.byteLength(JSON.stringify(settings), 'utf8') > MODEL_SELECTION_LIMITS.catalogBytes) reject('resource-limit')
  if (isConfigUnreadable()) reject('config-unreadable')
  const next = { ...config, subagentModels: settings }
  const previousSnapshot = snapshot
  saveConfig({ aiSources: next })
  if (isConfigUnreadable()) reject('config-unreadable')
  if (snapshot === previousSnapshot) replaceSnapshot(next)
  return projectSubagentModelSettings(settings)
}
function checkedInput(input: unknown, config: AISourcesConfig, settings: SubagentModelSettings, existing?: SubagentModelProfile): SubagentModelInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('invalid-input')
  const item = input as Record<string, unknown>
  const keys = existing ? ['id', 'expectedRevision', 'name', 'description', 'target'] : ['name', 'description', 'target']
  if (Object.keys(item).some(key => !keys.includes(key))) reject('invalid-input')
  const builtin = existing?.kind === 'builtin'
  if (builtin && item.name !== undefined) reject('builtin-immutable')
  const name = builtin ? subagentModelName(existing) : item.name
  if (!validSubagentModelText(name, MODEL_SELECTION_LIMITS.nameCodePoints) || !name.trim()) reject('invalid-name')
  if (!validSubagentModelText(item.description, MODEL_SELECTION_LIMITS.descriptionCodePoints)) reject('invalid-description')
  const normalized = normalizeSubagentModelName(name)
  if (!builtin && (['small', 'medium', 'large', 'small cup', 'medium cup', 'large cup', '小杯', '中杯', '大杯'].includes(normalized)
    || settings.profiles.some(profile => profile.id !== existing?.id && normalizeSubagentModelName(subagentModelName(profile)) === normalized))) reject('name-duplicate')
  if (!isSubagentModelTarget(item.target)) reject('invalid-target')
  const target = item.target
  if (target.kind === 'model') {
    const source = config.sources.find(source => source.id === target.sourceId)
    if (!source) reject('unknown-source')
    if (!findSubagentSourceModel(source, target.modelId)) reject('unknown-model')
  } else if (!config.groups?.some(group => group.id === target.groupId && hasUsableSubagentGroup(group, config.sources))) reject('unknown-group')
  return { name: name.trim(), description: item.description, target }
}
function changed(settings: SubagentModelSettings, profiles: SubagentModelProfile[]): SubagentModelSettings {
  const active = hasBoundTarget(profiles)
  const selectionMode = active ? settings.selectionMode : 'inherit'
  const policyChanged = active !== hasBoundTarget(settings.profiles) || selectionMode !== settings.selectionMode
  return { version: 1, profiles, revision: settings.revision + 1, selectionMode,
    policyRevision: settings.policyRevision + (policyChanged ? 1 : 0) }
}
function find(settings: SubagentModelSettings, input: SubagentModelRevisionInput): SubagentModelProfile {
  if (!input || typeof input.id !== 'string' || !Number.isSafeInteger(input.expectedRevision)) reject('invalid-input')
  const profile = projectSubagentModelSettings(settings).profiles.find(profile => profile.id === input.id)
  if (!profile) reject('not-found')
  if (profile.revision !== input.expectedRevision) reject('revision-conflict')
  return profile
}
export function createSubagentModel(input: SubagentModelInput): SubagentModelSettings {
  const config = sources(); const settings = config.subagentModels ?? emptySubagentModelSettings()
  const value = checkedInput(input, config, settings)
  const profile: SubagentModelProfile = { ...value, kind: 'custom', id: randomUUID(), revision: 1 }
  return persist(config, changed(settings, [...settings.profiles, profile]))
}
export function updateSubagentModel(input: SubagentModelUpdate): SubagentModelSettings {
  const config = sources(); const settings = config.subagentModels ?? emptySubagentModelSettings()
  const existing = find(settings, input)
  const value = checkedInput(input, config, settings, existing)
  const profile: SubagentModelProfile = existing.kind === 'builtin'
    ? { id: builtinSubagentModelId(existing.slot), kind: 'builtin', slot: existing.slot, revision: existing.revision + 1, description: value.description, target: value.target }
    : { ...value, kind: 'custom', id: existing.id, revision: existing.revision + 1 }
  if (existing.description === profile.description && subagentModelName(existing) === subagentModelName(profile)
    && JSON.stringify(existing.target) === JSON.stringify(profile.target)) return projectSubagentModelSettings(settings)
  const profiles = existing.revision === 0 ? [...settings.profiles, profile]
    : settings.profiles.map(item => item.id === existing.id ? profile : item)
  return persist(config, changed(settings, profiles))
}
export function clearBuiltinSubagentModel(input: SubagentModelRevisionInput): SubagentModelSettings {
  const config = sources(); const settings = config.subagentModels ?? emptySubagentModelSettings()
  if (!input || Object.keys(input).some(key => !['id', 'expectedRevision'].includes(key))) reject('invalid-input')
  const existing = find(settings, input)
  if (existing.kind !== 'builtin' || !SUBAGENT_MODEL_SLOTS.includes(existing.slot)) reject('builtin-required')
  if (!existing.target) return projectSubagentModelSettings(settings)
  const { target: _target, ...rest } = existing
  const profile = { ...rest, revision: existing.revision + 1 }
  return persist(config, changed(settings, settings.profiles.map(item => item.id === existing.id ? profile : item)))
}
export function deleteSubagentModel(input: SubagentModelRevisionInput): SubagentModelSettings {
  const config = sources(); const settings = config.subagentModels ?? emptySubagentModelSettings()
  if (!input || Object.keys(input).some(key => !['id', 'expectedRevision'].includes(key))) reject('invalid-input')
  const existing = find(settings, input)
  if (existing.kind !== 'custom') reject('builtin-immutable')
  return persist(config, changed(settings, settings.profiles.filter(item => item.id !== existing.id)))
}
export function setSubagentModelSelectionMode(input: SubagentModelModeInput): SubagentModelSettings {
  const config = sources(); const settings = config.subagentModels ?? emptySubagentModelSettings()
  if (!input || Object.keys(input).some(key => !['selectionMode', 'expectedRevision'].includes(key)) || !['inherit', 'task'].includes(input.selectionMode)) reject('invalid-input')
  if (input.expectedRevision !== settings.revision) reject('revision-conflict')
  if (input.selectionMode === settings.selectionMode) return projectSubagentModelSettings(settings)
  if (!settings.profiles.some(profile => profile.target)) reject('no-targets')
  return persist(config, { ...settings, selectionMode: input.selectionMode, revision: settings.revision + 1, policyRevision: settings.policyRevision + 1 })
}
