/**
 * Shared quota number/affix formatting for QuotaPill and QuotaPopover.
 *
 * Amounts arrive already converted to the site's display unit (the provider
 * does no math), but may be fractional in currency modes. These helpers trim
 * decimals and apply the snapshot's display affix consistently in both places.
 */

import { resolveLocalizedText, type AuthQuotaSnapshot } from '../../../shared/types'
import { getCurrentLanguage } from '../../i18n'

/** Trim a quota amount to at most 2 decimals; integers stay integer. */
export function formatQuotaNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))
}

/**
 * Render a quota amount with the snapshot's display affix: a currency `symbol`
 * as prefix (e.g. "$186"), else a `unit` word as suffix (e.g. "186 积分"), else
 * the bare number.
 */
export function formatQuotaValue(
  n: number,
  snapshot: Pick<AuthQuotaSnapshot, 'symbol' | 'unit'>
): string {
  const num = formatQuotaNumber(n)
  if (snapshot.symbol) return `${snapshot.symbol}${num}`
  if (snapshot.unit) return `${num} ${resolveLocalizedText(snapshot.unit, getCurrentLanguage())}`
  return num
}
