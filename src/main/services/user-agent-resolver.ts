import { app, type Session } from 'electron'
import { chromiumUserAgent, configureChromiumIdentity } from '../foundation/chromium-user-agent'

export const H5_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

export type DeviceMode = 'pc' | 'h5'

export function resolveUserAgent(
  customUserAgent: string | undefined,
  deviceMode: DeviceMode,
  nativeUserAgent?: string
): string {
  const custom = customUserAgent?.trim()
  if (custom) return custom
  return deviceMode === 'h5' ? H5_USER_AGENT : chromiumUserAgent(nativeUserAgent ?? app.userAgentFallback)
}

const sessionIdentities = new WeakMap<Session, string>()

/** Workers and popup requests use the session default rather than a page's override. */
export function configureBrowserSession(browserSession: Session, customUserAgent: string | undefined): void {
  const nativeUserAgent = configureChromiumIdentity()
  const userAgent = resolveUserAgent(customUserAgent, 'pc', nativeUserAgent)
  if (sessionIdentities.get(browserSession) !== userAgent || browserSession.getUserAgent() !== userAgent) {
    browserSession.setUserAgent(userAgent)
    sessionIdentities.set(browserSession, userAgent)
  }
}
