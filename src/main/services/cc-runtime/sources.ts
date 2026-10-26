import type { CcDownloadSource, CcRuntimePreferences } from '../../../shared/types/cc-runtime'
import { CcRuntimeError } from './errors'
import { OFFICIAL_SOURCE, VERSION_PATTERN } from './policy'

export function validateSource(source: CcDownloadSource): CcDownloadSource {
  if (!source || typeof source.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(source.id) || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 80) {
    throw new CcRuntimeError('invalid-source')
  }
  let url: URL
  if (typeof source.baseUrl !== 'string' || source.baseUrl.length > 2048) throw new CcRuntimeError('invalid-source')
  try { url = new URL(source.baseUrl) } catch { throw new CcRuntimeError('invalid-source') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new CcRuntimeError('invalid-source')
  return { id: source.id, name: source.name.trim(), baseUrl: url.toString().replace(/\/+$/, '') }
}

export function getSources(preferences?: CcRuntimePreferences): CcDownloadSource[] {
  const sources = [OFFICIAL_SOURCE]
  const ids = new Set(['official'])
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
    result.sources = result.sources.map(validateSource)
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
