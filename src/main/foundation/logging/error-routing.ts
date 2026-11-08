/**
 * electron-log keeps one error handler for every logger made with
 * log.create(), and each new logger re-points it at its own error function.
 * Without this, uncaught errors land in whichever dedicated log file was
 * created last (halo-sdk.log) instead of main.log.
 *
 * Call after the dedicated transports exist and after startCatching().
 */

import log from 'electron-log/main.js'

// electron-log's runtime accepts logFn here; its type definitions omit it.
type ErrorHandlerWithLogFn = { setOptions(options: { logFn: (...args: unknown[]) => void }): void }

export function routeUncaughtErrorsToMainLog(): void {
  ;(log.errorHandler as unknown as ErrorHandlerWithLogFn).setOptions({ logFn: log.error })
}
