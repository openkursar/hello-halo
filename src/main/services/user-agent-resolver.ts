/**
 * User-Agent constants and resolver for the embedded AI Browser.
 *
 * Issue #124: users need to override the browser User-Agent for testing sites
 * that serve different content based on UA (Windows-specific pages, mobile
 * detection, anti-bot filters, etc.).
 *
 * Resolution order:
 *   1. User-configured `browser.userAgent` from Settings (highest priority).
 *   2. Built-in H5 UA when the view is in mobile (`h5`) device mode.
 *   3. Built-in desktop Chrome UA as the default.
 *
 * The constants and resolver live here (not in `browser-view.service.ts`) so
 * that:
 *   - There is no circular dependency between the two modules.
 *   - The resolver can be unit tested without an Electron runtime —
 *     `browser-view.service.ts` cannot be imported in Vitest because it pulls
 *     in Electron's `BrowserView` at module load time.
 */

// Desktop Chrome User-Agent to avoid detection as Electron app.
export const CHROME_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Mobile (H5) User-Agent — iPhone Safari is the safest default for mobile H5
// pages. Most H5 sites are optimized for iOS Safari, making it the best
// emulation target.
export const H5_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

/**
 * Device emulation mode for a browser view. Duplicated here (alongside the
 * copy in `browser-view.service.ts`) as a type-only declaration so this module
 * has zero runtime dependency on the Electron-bound service.
 */
export type DeviceMode = 'pc' | 'h5'

/**
 * Resolve the effective User-Agent string for a browser view.
 *
 * @param customUserAgent — value from `config.browser.userAgent` (may be
 *   undefined / empty / whitespace-only).
 * @param deviceMode — current device emulation mode of the view.
 * @returns The UA string to pass to `webContents.setUserAgent()`.
 */
export function resolveUserAgent(
  customUserAgent: string | undefined,
  deviceMode: DeviceMode
): string {
  if (customUserAgent && customUserAgent.trim()) {
    return customUserAgent.trim()
  }
  return deviceMode === 'h5' ? H5_USER_AGENT : CHROME_USER_AGENT
}
