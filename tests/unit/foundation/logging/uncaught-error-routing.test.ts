/**
 * Where main-process uncaught exceptions and unhandled rejections are logged.
 *
 * electron-log shares one error handler across every logger created with
 * log.create(), and each new logger points it at its own error function. The
 * dedicated halo-sdk / http-raw loggers would otherwise capture the crashes
 * that support reads from main.log.
 */

import { describe, it, expect } from 'vitest'
import log from 'electron-log/main.js'
import '../../../../src/main/foundation/logging/sdk-transport'
import '../../../../src/main/foundation/logging/http-transport'
import { routeUncaughtErrorsToMainLog } from '../../../../src/main/foundation/logging'

type HandlerWithLogFn = { logFn?: unknown }

describe('uncaught error routing', () => {
  it('a dedicated logger created later takes over the shared handler', () => {
    log.create({ logId: 'probe' })
    expect((log.errorHandler as unknown as HandlerWithLogFn).logFn).not.toBe(log.error)
  })

  it('routes the shared handler back to the main logger', () => {
    routeUncaughtErrorsToMainLog()
    expect((log.errorHandler as unknown as HandlerWithLogFn).logFn).toBe(log.error)
  })
})
