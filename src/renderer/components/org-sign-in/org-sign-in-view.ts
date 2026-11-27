import type { OrgSignInState } from '../../../shared/types/enterprise-identity'

export type OrgIndicatorTone = 'hidden' | 'pending' | 'muted' | 'attention' | 'ok'
export type OrgSignInNotice = 'pending' | 'withdrawal' | 'incompatible' | 'temporary' | 'issue-failed' | 'read-failed'

export function orgSignInCardView(state: OrgSignInState | null, readFailed: boolean, desktop: boolean) {
  const available = state ? state.status !== 'unconfigured' : readFailed
  const signedIn = state?.status === 'active'
  const working = state?.capabilities.filter(c => c.status === 'ready') ?? []
  const expired = state?.capabilities.filter(c => c.status === 'expired') ?? []
  const nothingWorks = state?.status === 'signed-out' || working.length === 0
  const notice: OrgSignInNotice | null = state?.withdrawalPending ? 'withdrawal'
    : state?.status === 'unavailable' ? (state.unavailableReason ?? 'temporary')
      : readFailed ? 'read-failed'
        : state?.credentialFailed ? 'issue-failed'
          : state?.status === 'loading' || state?.status === 'restoring' ? 'pending' : null
  const offerRetry = available && (notice === 'read-failed' || (desktop &&
    (notice === 'withdrawal' || notice === 'temporary' || notice === 'issue-failed')))
  // A capability missing while others work is not part of this sign-in; signing in again would not add it.
  const offerSignIn = available && !notice && (signedIn || state?.status === 'signed-out') &&
    (nothingWorks || expired.length > 0)
  return {
    available, signedIn, working, expired, nothingWorks, notice, offerRetry, offerSignIn,
    status: notice === 'withdrawal' ? 'withdrawal-pending' : state?.status ?? 'unavailable',
    tools: state?.boundTools ?? [],
  }
}

/**
 * Where the sign-in appears among the AI model accounts: its own card once
 * there is anything to show or manage, otherwise an option among the logins
 * (desktop only, where signing in is possible).
 */
export function orgSettingsPlacement(state: OrgSignInState | null, readFailed: boolean, desktop: boolean, hasAccount: boolean): 'card' | 'option' | 'none' {
  if (hasAccount || state?.withdrawalPending) return 'card'
  if (!state) return readFailed ? 'card' : 'none'
  switch (state.status) {
    case 'active':
    case 'restoring':
    case 'unavailable':
      return 'card'
    case 'signed-out':
      return desktop ? 'option' : 'none'
    default:
      return 'none'
  }
}

/**
 * Where the organization option goes among the logins shown: the place of the
 * first login it stands for, or first when it stands for none.
 */
export function organizationOptionIndex<T extends { organizationSignIn?: true }>(all: T[], shown: T[]): number {
  const replaced = all.findIndex(provider => provider.organizationSignIn)
  return replaced < 0 ? 0 : shown.filter(provider => all.indexOf(provider) < replaced).length
}

/** "A, B and C" in the reader's language. */
export function joinLabels(labels: string[], language: string): string {
  try {
    return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(labels)
  } catch {
    return labels.join(', ')
  }
}

export function orgIndicatorView(state: OrgSignInState | null, desktop: boolean, readFailed = false) {
  const view = orgSignInCardView(state, readFailed, desktop)
  const { working, expired, notice, nothingWorks } = view
  const tone: OrgIndicatorTone = !view.available ? 'hidden' : notice === 'pending' ? 'pending' :
    notice === 'withdrawal' || notice === 'issue-failed' ? 'attention' : notice ? 'muted' :
      nothingWorks || expired.length > 0 ? 'attention' : 'ok'
  const clickSignsIn = tone === 'attention' && !notice && nothingWorks && desktop && !state?.signingIn
  return { ...view, tone, clickSignsIn }
}
