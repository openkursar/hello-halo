/**
 * Required-config validation for an installed app's `config_schema`.
 *
 * Runtime treats config purely as prompt material: `mergeConfigWithDefaults`
 * fills defaults and nothing ever inspects `required`, so an app whose required
 * fields are empty still starts, schedules and "succeeds" — it just behaves
 * wrong silently. These helpers give the UI a way to surface that, and keep the
 * "is this filled?" rule in one place so a future main-process validator does
 * not fork the semantics.
 */

import type { InputDef } from './spec-types'

/**
 * Whether a config value carries content.
 *
 * `false` and `0` are legitimate answers for boolean/number fields, so only
 * absent values, blank strings and empty lists count as unfilled.
 */
export function hasConfigValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

/** The value runtime would see: the user's entry, falling back to the schema default. */
export function resolveConfigValue(def: InputDef, userConfig: Record<string, unknown> | undefined): unknown {
  const value = userConfig?.[def.key]
  return value === undefined ? def.default : value
}

/** Required fields that runtime would receive empty, in schema order. */
export function findMissingRequiredConfig(
  configSchema: InputDef[] | undefined,
  userConfig: Record<string, unknown> | undefined
): InputDef[] {
  if (!configSchema?.length) return []
  return configSchema.filter(def => def.required && !hasConfigValue(resolveConfigValue(def, userConfig)))
}
