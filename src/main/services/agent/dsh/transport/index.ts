/**
 * Public surface of the dsh transport module.
 *
 * Owns the runtime child process and the JSON-RPC wire. Produces
 * `DshRuntimeClient` (declared in `../types`); it does not interpret session
 * events — that is the normalizer's job.
 */

export { createDshRuntimeClient, type DshRuntimeClientOptions } from './runtime-client'
export {
  DshRequestTimeoutError,
  DshResponseError,
  DshTransportClosedError,
} from './jsonrpc-client'
export { DEFAULT_SHUTDOWN_TIMINGS, type DshShutdownTimings } from './connection'
