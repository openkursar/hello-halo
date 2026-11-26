/**
 * cli-tools — installed command-line tools, each with launchers at a fixed
 * path and a skill naming them, run on the bundled runtime. Public surface
 * only; see DESIGN.md.
 */

export { CliToolStore, COMMAND_NAME_PATTERN, EXTERNAL_VERSION, GUIDE_MAX_BYTES, commandOnPath, compareVersions, toolBlock } from './store'
export {
  applyCatalogRevocations,
  applyCatalogStatus,
  batchCurrentToolChanges,
  buildToolViews,
  catalogSignatureMode,
  getCliToolsOverview,
  importUserPackage,
  peekOrganizationTools,
  recordCliToolSkill,
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
  getPreparedCurrentToolsRevision,
  onDidChangeCurrentTools,
  readCurrentToolSkills,
  readCliToolState,
  recordCliDeliveryFailure,
} from './host'
export type { CatalogPackageExpectation, CliToolsHostOptions, OrganizationTool, UserPackagePreview } from './host'
export { parseCatalogSignature, signedBytes, signedGuideBytes, signedSkillBytes, guideSignatureAccepted, skillSignatureAccepted, TRUSTED_KEYS_FILE } from './signature'
export type { CatalogSignature, TrustMode } from './signature'
export type {
  CliDeliveryFailure,
  CliToolInstallRecord,
  CliToolRecord,
  CliToolSource,
  CliToolState,
  CliToolStoreOptions,
  CliToolVersionRecord,
  CliExternalRecord,
  CatalogGuideOverride,
  CatalogToolStatus,
  PackagePreview,
  RegisterExternalOptions,
  ImportOptions,
  ImportResult,
} from './store'
export type { CliToolSkillSummary } from './store'
export { cliSkillName, CLI_SKILL_DESCRIPTION_MAX } from './skills'
export type { CliSkillSource, CliToolSkill } from './skills'
export { CliToolError, isCliToolError } from './errors'
export { validateCredentialBinding } from './credentials'
export type { CliCredentialBinding } from './credentials'
export type { CliSupportFilesConfig } from './support-files'
export type { CliToolErrorCode } from './errors'
export { CLI_MANIFEST_SCHEMA, parseCliManifest } from './manifest'
export type { CliManifest } from './manifest'
export { computePayloadIntegrity } from './payload'
export { DEFAULT_ARCHIVE_LIMITS } from './archive'
export type { ArchiveLimits } from './archive'
