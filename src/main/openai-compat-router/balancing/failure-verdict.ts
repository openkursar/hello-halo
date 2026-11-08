/**
 * What a failure says about the member that suffered it.
 *
 * The router cannot rely on a third party naming its trouble correctly, so the
 * judgment reads whatever evidence exists — a status, a quota word in the body,
 * a time the provider announced — and falls back to plain "it failed". Only
 * evidence that something is wrong with the member (not with the request) puts
 * it to rest.
 */

import { parseAnnouncedUntil } from './announced-time'
import type { FailureEvidence, RestReason, RestScope } from './types'

/** Wording of a spent quota or an unpaid account, wherever a provider puts it. */
const QUOTA_WORDING =
  /quota|usage[\s_-]?limit|billing|insufficient[\s_-]?(balance|credit|funds|quota)|credit balance|payment required|余额不足|额度|配额/i

export type Judgment =
  | { blame: 'request' }
  | {
      blame: 'member'
      reason: RestReason
      scope: RestScope
      /** Epoch ms the provider announced, unbounded; null when it announced nothing. */
      announcedUntil: number | null
      /** True when this failure puts the member to rest by itself; false when it only counts toward a threshold. */
      immediate: boolean
    }

function member(reason: RestReason, scope: RestScope, announcedUntil: number | null, immediate: boolean): Judgment {
  return { blame: 'member', reason, scope, announcedUntil, immediate }
}

export function judgeFailure(evidence: FailureEvidence, now: number): Judgment {
  switch (evidence.kind) {
    case 'credential':
      return member('auth', 'account', null, true)
    case 'network':
    case 'timeout':
    case 'empty':
    case 'stream-error':
      return member('transient', 'member', null, false)
    case 'http':
      break
  }

  const { status, headers, body } = evidence
  const announced = parseAnnouncedUntil(headers, now)
  const quota = status === 402 || (status >= 400 && status < 500 && QUOTA_WORDING.test(body))
  if (quota) return member('quota', 'account', announced, true)
  if (status === 429 || status === 529) return member('rate', 'member', announced, true)
  if (status === 401) return member('auth', 'account', announced, true)
  if (status === 403) return member('auth', 'member', announced, true)
  if (status === 404) return member('unavailable', 'member', announced, true)
  if (status === 400 || status === 413 || status === 422) return { blame: 'request' }
  return member('transient', 'member', announced, false)
}
