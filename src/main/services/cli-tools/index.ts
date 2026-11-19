/**
 * cli-tools — installed command-line tools that agent executions can run on
 * the bundled runtime. Public surface only; see DESIGN.md.
 */

export { CliToolStore, commandOnPath } from './store'
export type {
  CliExecutionEntry,
  CliExecutionLock,
  CliToolRecord,
  CliToolSource,
  CliToolState,
  CliToolStoreOptions,
  CliToolVersionRecord,
  ExposedCommand,
  ImportOptions,
  ImportResult,
  PinExecutionOptions,
  PinnedExecution,
} from './store'
export { CliToolError, isCliToolError } from './errors'
export type { CliToolErrorCode } from './errors'
export { CLI_MANIFEST_SCHEMA, parseCliManifest } from './manifest'
export type { CliManifest } from './manifest'
export { computePayloadIntegrity } from './payload'
export { DEFAULT_ARCHIVE_LIMITS } from './archive'
export type { ArchiveLimits } from './archive'
