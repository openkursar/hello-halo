/**
 * cli-tools — installed command-line tools that agent executions can run on
 * the bundled runtime. Public surface only; see DESIGN.md.
 */

export { CliToolStore, COMMAND_NAME_PATTERN, EXTERNAL_VERSION, commandOnPath, compareVersions, toolBlock } from './store'
export {
  CLI_TOOLS_BIN_ENV,
  applyCatalogRevocations,
  applyCatalogStatus,
  applyCliToolsEnv,
  buildToolViews,
  catalogSignatureMode,
  getCliToolsOverview,
  holdCliTools,
  importUserPackage,
  previewUserPackage,
  reconfirmExternalProgram,
  registerExternalProgram,
  removeCliTool,
  removeCliToolVersion,
  setCliToolCurrent,
  setCliToolDisabled,
  verifyCatalogSignature,
  initCliTools,
  installCatalogPackage,
  prepareCliTools,
  readCliToolState,
} from './host'
export type { CatalogPackageExpectation, CliToolsHostOptions, UserPackagePreview } from './host'
export { parseCatalogSignature, signedBytes, TRUSTED_KEYS_FILE } from './signature'
export type { CatalogSignature, TrustMode } from './signature'
export type {
  CliExecutionEntry,
  CliExecutionLock,
  CliToolRecord,
  CliToolSource,
  CliToolState,
  CliToolStoreOptions,
  CliToolVersionRecord,
  CliExternalRecord,
  CatalogToolStatus,
  PackagePreview,
  RegisterExternalOptions,
  ExposedCommand,
  ImportOptions,
  ImportResult,
  PinExecutionOptions,
  PinCurrentOptions,
  PinnedExecution,
} from './store'
export { CliToolError, isCliToolError } from './errors'
export type { CliToolErrorCode } from './errors'
export { CLI_MANIFEST_SCHEMA, parseCliManifest } from './manifest'
export type { CliManifest } from './manifest'
export { computePayloadIntegrity } from './payload'
export { DEFAULT_ARCHIVE_LIMITS } from './archive'
export type { ArchiveLimits } from './archive'
