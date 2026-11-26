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
  const offerSignIn = available && !notice && (signedIn || state?.status === 'signed-out') &&
    (nothingWorks || expired.length > 0 || state?.capabilities.some(c => c.status === 'missing'))
  return {
    available, signedIn, working, expired, nothingWorks, notice, offerRetry, offerSignIn,
    status: notice === 'withdrawal' ? 'withdrawal-pending' : state?.status ?? 'unavailable',
    tools: state?.boundTools ?? [],
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
