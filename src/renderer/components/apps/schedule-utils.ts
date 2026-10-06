/**
 * Schedule utilities — shared types, constants, and conversion functions
 * for the schedule picker and frequency editor.
 *
 * Centralizes FREQUENCY_PRESETS (previously duplicated in AppInstallDialog
 * and AppConfigPanel) and provides cron ↔ picker bidirectional conversion.
 */

import cronstrue from 'cronstrue'
import 'cronstrue/locales/zh_CN'
import 'cronstrue/locales/zh_TW'
import 'cronstrue/locales/ja'
import 'cronstrue/locales/es'
import 'cronstrue/locales/fr'
import 'cronstrue/locales/de'
import type { SubscriptionDef } from '../../../shared/apps/spec-types'

// ============================================
// Shared Constants
// ============================================

export const FREQUENCY_PRESETS = [
  { label: '1m', value: '1m' },
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' },
  { label: '30m', value: '30m' },
  { label: '1h', value: '1h' },
  { label: '2h', value: '2h' },
  { label: '6h', value: '6h' },
  { label: '12h', value: '12h' },
  { label: '1d', value: '1d' },
] as const

// ============================================
// Types
// ============================================

// Re-export from renderer types layer (single source of truth)
export type { ScheduleValue } from '../../types'
import type { ScheduleValue } from '../../types'

/** State representation for the cron visual picker */
export interface CronPickerState {
  repeatType: 'daily' | 'weekly' | 'monthly'
  weekDays?: number[]     // 0-6, 0=Sunday
  monthDays?: number[]    // 1-31
  hour: number            // 0-23
  minute: number          // 0-59
}

// ============================================
// Extraction / Application
// ============================================

/** Extract a ScheduleValue from a SubscriptionDef */
export function extractScheduleValue(sub: SubscriptionDef): ScheduleValue | null {
  if (sub.source.type !== 'schedule') return null
  const config = sub.source.config
  if (config.cron) return { type: 'cron', cron: config.cron }
  if (config.every) return { type: 'every', every: config.every }
  return null
}

/** Apply a ScheduleValue back to a SubscriptionDef (returns a new copy) */
export function applyScheduleValue(sub: SubscriptionDef, value: ScheduleValue): SubscriptionDef {
  if (sub.source.type !== 'schedule') return sub
  const timing = value.type === 'every'
    ? { every: value.every }
    : { cron: value.cron }
  const { workday_calendar } = sub.source.config
  return {
    ...sub,
    source: { type: 'schedule' as const, config: workday_calendar ? { ...timing, workday_calendar } : timing },
  }
}

/** Limit a schedule to mainland China working days, or lift the limit (returns a new copy). */
export function applyWorkdayCalendar(sub: SubscriptionDef, enabled: boolean): SubscriptionDef {
  if (sub.source.type !== 'schedule') return sub
  const { workday_calendar: _previous, ...timing } = sub.source.config
  return {
    ...sub,
    source: { type: 'schedule' as const, config: enabled ? { ...timing, workday_calendar: true } : timing },
  }
}

// ============================================
// Duration Helpers
// ============================================

/** Parse a duration string like "30m", "2h", "1d" into milliseconds */
export function durationToMs(dur: string): number {
  const match = dur.match(/^(\d+)([smhd])$/)
  if (!match) return 0
  const val = Number(match[1])
  switch (match[2]) {
    case 's': return val * 1000
    case 'm': return val * 60_000
    case 'h': return val * 3_600_000
    case 'd': return val * 86_400_000
    default: return 0
  }
}

/** Format a duration string to a human-readable label */
export function formatFrequency(dur: string, t: (s: string, opts?: Record<string, unknown>) => string): string {
  const match = dur.match(/^(\d+)([smhd])$/)
  if (!match) return dur
  const val = Number(match[1])
  switch (match[2]) {
    case 's': return t('Every {{count}}s', { count: val })
    case 'm': return t('Every {{count}}m', { count: val })
    case 'h': return t('Every {{count}}h', { count: val })
    case 'd': return t('Every {{count}}d', { count: val })
    default: return dur
  }
}

export function isValidPreset(freq: string): boolean {
  return FREQUENCY_PRESETS.some(p => p.value === freq)
}

// ============================================
// Cron ↔ Picker Conversion
// ============================================

/**
 * Build a cron string from picker state.
 *
 * Generates standard 5-field cron: minute hour dom month dow
 * Visual picker supports a single time point only.
 * For multiple trigger times, users should edit YAML directly.
 */
export function buildCronFromPicker(state: CronPickerState): string {
  const m = state.minute
  const h = state.hour

  switch (state.repeatType) {
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekly': {
      const days = (state.weekDays ?? []).sort((a, b) => a - b)
      const dowField = days.length > 0 ? days.join(',') : '*'
      return `${m} ${h} * * ${dowField}`
    }
    case 'monthly': {
      const mdays = (state.monthDays ?? []).sort((a, b) => a - b)
      const domField = mdays.length > 0 ? mdays.join(',') : '1'
      return `${m} ${h} ${domField} * *`
    }
    default:
      return `${m} ${h} * * *`
  }
}

/**
 * Parse a cron string to a picker state.
 * Returns null if the cron cannot be represented by the visual picker.
 *
 * The visual picker supports exactly one time point (single minute + single hour).
 * Multi-value minute/hour fields (e.g. "0,30 9,18 * * *") are treated as complex
 * and fall back to read-only display with a hint to edit in YAML.
 *
 * Supported patterns:
 * - Single minute + single hour + * dom + * month + * dow (daily)
 * - Single minute + single hour + * dom + * month + fixed dow (weekly)
 * - Single minute + single hour + fixed dom + * month + * dow (monthly)
 */
export function parseCronToPickerState(cron: string): CronPickerState | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const [minuteField, hourField, domField, monthField, dowField] = parts

  // Month must be *
  if (monthField !== '*') return null

  // dom and dow cannot both have non-* values
  if (domField !== '*' && dowField !== '*') return null

  // Parse minute — must be a single fixed value
  const minutes = parseFixedValues(minuteField, 0, 59)
  if (!minutes || minutes.length !== 1) return null

  // Parse hour — must be a single fixed value
  const hours = parseFixedValues(hourField, 0, 23)
  if (!hours || hours.length !== 1) return null

  const minute = minutes[0]
  const hour = hours[0]

  // Determine repeat type
  if (dowField !== '*') {
    const weekDays = parseFixedValues(dowField, 0, 6)
    if (!weekDays) return null
    return { repeatType: 'weekly', weekDays, hour, minute }
  }

  if (domField !== '*') {
    const monthDays = parseFixedValues(domField, 1, 31)
    if (!monthDays) return null
    return { repeatType: 'monthly', monthDays, hour, minute }
  }

  return { repeatType: 'daily', hour, minute }
}

/** Parse a cron field as a list of fixed integer values. Returns null on failure. */
function parseFixedValues(field: string, min: number, max: number): number[] | null {
  // Reject step, range-with-step, wildcard-step patterns
  if (field.includes('/') || field === '*') {
    // Bare * is OK — it means "all values" but we handle that at the caller
    if (field === '*') return null // caller checks * separately
    return null
  }

  // Handle ranges like "1-5"
  const parts = field.split(',')
  const values: number[] = []

  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-')
      const start = Number(startStr)
      const end = Number(endStr)
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) return null
      for (let i = start; i <= end; i++) values.push(i)
    } else {
      const n = Number(part)
      if (isNaN(n) || n < min || n > max) return null
      values.push(n)
    }
  }

  return values.length > 0 ? [...new Set(values)].sort((a, b) => a - b) : null
}

// ============================================
// Human-Readable Cron Description
// ============================================

/** Map i18n locale codes to cronstrue locale identifiers */
function mapLocale(locale: string): string {
  const mapping: Record<string, string> = {
    'zh-CN': 'zh_CN',
    'zh-TW': 'zh_TW',
    'ja': 'ja',
    'es': 'es',
    'fr': 'fr',
    'de': 'de',
    'en': 'en',
  }
  return mapping[locale] ?? 'en'
}

/** Convert a cron expression to a human-readable description */
export function formatCronHumanReadable(cron: string, locale = 'en'): string {
  try {
    return cronstrue.toString(cron, {
      locale: mapLocale(locale),
      use24HourTimeFormat: true,
    })
  } catch {
    return cron
  }
}
