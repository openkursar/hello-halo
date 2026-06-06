/**
 * Logging Infrastructure Module
 *
 * Centralized logging subsystem for the Halo main process.
 * Groups all dedicated log transports and the controller that orchestrates them.
 *
 * Architecture:
 *   controller.ts     — Central toggle: subscribes to config, dispatches to transports
 *   http-transport.ts — Dedicated http-raw.log for raw HTTP traffic (DevMode only)
 *   sdk-transport.ts  — Dedicated halo-sdk.log for SDK runtime events (always-on info)
 *   redact.ts         — Shared redaction utilities for log sanitization
 *
 * Contract:
 *   - Only controller.ts subscribes to config changes.
 *   - Transports expose set-level/set-enabled functions; they never subscribe to config.
 *   - New transports follow the same pattern: expose toggle, register in controller.
 *
 * Side-effect import:
 *   Importing this module triggers controller.ts self-registration (config subscription).
 *   This is identical to the previous `import './services/developer-mode'` pattern.
 */

// Controller (side-effect: self-registers config subscription at import time)
export { isDeveloperMode } from './controller'

// HTTP transport
export {
  setHttpLogging,
  isHttpLoggingEnabled,
  logHttpRequest,
  logHttpResponse,
  logHttpResponseBody,
} from './http-transport'
export type { HttpRequestLogEntry, HttpResponseLogEntry } from './http-transport'

// SDK transport
export { installSdkLogger, setSdkLogLevel, getSdkLogLevel } from './sdk-transport'

// Redaction utilities
export { redactHeaders, redactSecrets, truncateField } from './redact'
