import type { RuntimeDownloadSource, RuntimePreferences } from '../../../shared/types/external-runtime';
import type { RuntimeProvider } from './provider';
import { RuntimeError } from './errors';
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const PRESET_SOURCE_ID = 'preset';
export function isInstallVersion(version: string): boolean {
  return typeof version === 'string' && version.length <= 80 && (VERSION_PATTERN.test(version) || version === 'stable' || version === 'latest');
}
export function validateSource(source: RuntimeDownloadSource): RuntimeDownloadSource {
  if (!source || typeof source.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(source.id) || typeof source.name !== 'string' || !source.name.trim() && source.id !== PRESET_SOURCE_ID || source.name.length > 80) {
    throw new RuntimeError('invalid-source');
  }
  let url: URL;
  if (typeof source.baseUrl !== 'string' || source.baseUrl.length > 2048) {
    throw new RuntimeError('invalid-source');
  }
  try {
    url = new URL(source.baseUrl);
  } catch {
    throw new RuntimeError('invalid-source');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RuntimeError('invalid-source');
  }
  return {
    id: source.id,
    name: source.name.trim(),
    baseUrl: url.toString().replace(/\/+$/, '')
  };
}
export function createRuntimeSources(provider: RuntimeProvider) {
  let invalidPresetReported = false;
  function presetSource(): RuntimeDownloadSource | undefined {
    const declared = provider.presetSource();
    if (!declared) {
      return undefined;
    }
    try {
      return validateSource({
        id: PRESET_SOURCE_ID,
        name: declared.name ?? '',
        baseUrl: declared.baseUrl
      });
    } catch {
      if (!invalidPresetReported) {
        invalidPresetReported = true;
        console.warn('[ExternalRuntime] Invalid product download source ignored', {
          runtimeId: provider.id
        });
      }
      return undefined;
    }
  }
  function getSources(preferences?: RuntimePreferences): RuntimeDownloadSource[] {
    const preset = presetSource();
    const sources = preset ? [provider.officialSource, preset] : [provider.officialSource];
    const ids = new Set(sources.map(source => source.id));
    for (const source of preferences?.sources || []) {
      if (!ids.has(source.id)) {
        sources.push(source);
        ids.add(source.id);
      }
    }
    return sources.map(source => ({
      ...source
    }));
  }
  function getEffectiveSourceId(preferences?: RuntimePreferences): string {
    if (preferences?.sourceId && getSources(preferences).some(source => source.id === preferences.sourceId)) {
      return preferences.sourceId;
    }
    return presetSource() ? PRESET_SOURCE_ID : provider.officialSource.id;
  }
  function validatePreferences(preferences: RuntimePreferences): RuntimePreferences {
    const result = {
      sources: preferences.sources,
      sourceId: preferences.sourceId,
      installVersion: preferences.installVersion
    };
    if (result.sources) {
      if (!Array.isArray(result.sources) || result.sources.length > 12) {
        throw new RuntimeError('invalid-source');
      }
      result.sources = result.sources.filter(source => source?.id !== PRESET_SOURCE_ID).map(validateSource);
      const ids = result.sources.map(source => source.id);
      if (new Set(ids).size !== ids.length || result.sources.some(source => source.id === 'official' && source.baseUrl !== provider.officialSource.baseUrl)) {
        throw new RuntimeError('invalid-source');
      }
    }
    if (result.sourceId && !getSources(result).some(source => source.id === result.sourceId)) {
      throw new RuntimeError('invalid-source');
    }
    if (result.installVersion !== undefined && !isInstallVersion(result.installVersion)) {
      throw new RuntimeError('invalid-version');
    }
    return result;
  }
  return {
    getSources,
    getEffectiveSourceId,
    validatePreferences
  };
}
