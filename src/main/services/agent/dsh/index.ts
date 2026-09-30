/**
 * dsh SDK adapter public surface.
 *
 * Halo consumes every engine as an implementation of the Claude Code session
 * protocol. DeepSeek Harness speaks its own JSON-RPC protocol to a runtime
 * child process, so this module exposes a CC-compatible facade and keeps the
 * harness vocabulary inside the subtree.
 */

export { createDshSdkModule } from './module'
export { DSH_CAPABILITIES } from './capabilities'
export type { DshSdkModule } from './types'
