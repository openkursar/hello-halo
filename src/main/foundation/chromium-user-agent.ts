import { app } from 'electron'

// Keep Chromium's native platform and version, not the embedding application's products.
export function chromiumUserAgent(nativeUserAgent: string): string {
  return nativeUserAgent.replace(/\s[^\s/()]+\/[^\s()]+/g, product =>
    /^\s(?:AppleWebKit|Chrome|Safari)\//.test(product) ? product : ''
  )
}

/** Native popup first requests ignore session and WebContents user-agent overrides. */
export function configureChromiumIdentity(): string {
  const userAgent = chromiumUserAgent(app.userAgentFallback)
  if (app.userAgentFallback !== userAgent) app.userAgentFallback = userAgent
  return userAgent
}
