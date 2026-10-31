import type { CcDownloadSource, CcRuntimePreferences } from '../../../shared/types/cc-runtime'
import { getClaudeCodeDownloadSource } from '../../foundation/product-config'
import { CcRuntimeError } from './errors'
import { OFFICIAL_SOURCE, VERSION_PATTERN } from './policy'

/** Id of the source a build declares in product.json; reserved like `official`. */
export const PRESET_SOURCE_ID = 'preset'

let invalidPresetReported = false

/**
 * The build's own download source, when it declares a usable one. Without a
 * declared name it carries none; Settings names it in the user's language.
 */
function presetSource(): CcDownloadSource | undefined {
  const declared = getClaudeCodeDownloadSource()
  if (!declared) return undefined
  try {
    return validateSource({ id: PRESET_SOURCE_ID, name: declared.name ?? '', baseUrl: declared.baseUrl })
  } catch {
    if (!invalidPresetReported) {
      invalidPresetReported = true
      console.warn('[CcRuntime] Ignored product.json claudeCodeDownloadSource: baseUrl must be an HTTP or HTTPS URL of at most 2048 characters without credentials, query or fragment, and name at most 80 characters')
    }
    return undefined
  }
}

/**
 * The source to use: the user's choice while it still exists, else the build's
 * own source when it declares one, else the official source.
 */
export function getEffectiveSourceId(preferences?: CcRuntimePreferences): string {
  if (preferences?.sourceId && getSources(preferences).some(source => source.id === preferences.sourceId)) return preferences.sourceId
  return presetSource() ? PRESET_SOURCE_ID : OFFICIAL_SOURCE.id
}

export function validateSource(source: CcDownloadSource): CcDownloadSource {
  // Only the build's own source may come without a name; Settings names it.
  if (!source || typeof source.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(source.id) || typeof source.name !== 'string'
    || (!source.name.trim() && source.id !== PRESET_SOURCE_ID) || source.name.length > 80) {
    throw new CcRuntimeError('invalid-source')
  }
  let url: URL
  if (typeof source.baseUrl !== 'string' || source.baseUrl.length > 2048) throw new CcRuntimeError('invalid-source')
  try { url = new URL(source.baseUrl) } catch { throw new CcRuntimeError('invalid-source') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new CcRuntimeError('invalid-source')
  return { id: source.id, name: source.name.trim(), baseUrl: url.toString().replace(/\/+$/, '') }
}

export function getSources(preferences?: CcRuntimePreferences): CcDownloadSource[] {
  const preset = presetSource()
  const sources = preset ? [OFFICIAL_SOURCE, preset] : [OFFICIAL_SOURCE]
  const ids = new Set(sources.map(source => source.id))
  for (const source of preferences?.sources || []) {
    if (ids.has(source.id)) continue
    sources.push(source)
    ids.add(source.id)
  }
  return sources.map(source => ({ ...source }))
}

export function validatePreferences(preferences: CcRuntimePreferences): CcRuntimePreferences {
  const result: CcRuntimePreferences = { sources: preferences.sources, sourceId: preferences.sourceId, installVersion: preferences.installVersion }
  if (result.sources) {
    if (!Array.isArray(result.sources) || result.sources.length > 12) throw new CcRuntimeError('invalid-source')
    // The build's own source is never stored: a later build may move it.
    result.sources = result.sources.filter(source => source?.id !== PRESET_SOURCE_ID).map(validateSource)
    const ids = result.sources.map(source => source.id)
    if (new Set(ids).size !== ids.length || result.sources.some(source => source.id === 'official' && source.baseUrl !== OFFICIAL_SOURCE.baseUrl)) {
      throw new CcRuntimeError('invalid-source')
    }
  }
  if (result.sourceId && !getSources(result).some(source => source.id === result.sourceId)) throw new CcRuntimeError('invalid-source')
  if (result.installVersion !== undefined && !isInstallVersion(result.installVersion)) throw new CcRuntimeError('invalid-version')
  return result
}

export function isInstallVersion(version: string): boolean {
  return typeof version === 'string' && version.length <= 80 && (VERSION_PATTERN.test(version) || version === 'stable' || version === 'latest')
}
