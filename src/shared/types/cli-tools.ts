/**
 * Local command-line tool management — what the renderer sees of the tools
 * installed on this device. No path to a managed file and no credential is
 * included; a registered program's own path is shown because the user chose it.
 */

export type CliToolSourceKind = 'preset' | 'catalog' | 'user-import' | 'external'

/** Why a tool is not used by new tasks; `available` when it is. */
export type CliToolStatus = 'available' | 'disabled' | 'revoked' | 'delisted' | 'external-changed' | 'no-current'

export interface CliToolVersionView {
  version: string
  source: CliToolSourceKind
  current: boolean
  commands: string[]
  importedAt: string
  minNode?: string
  sideEffects?: 'read-only' | 'writes'
  auth?: 'none' | 'env-ref' | 'external-login'
  /** The catalog no longer lists this version (informational). */
  withdrawn?: boolean
  /** Pinned by a running task; deleting it defers its files. */
  inUse: boolean
  /** Whether a delete action is offered (not current, not shipped with Halo). */
  removable: boolean
  external?: {
    path: string
    interpreter: 'halo-node' | null
    registeredAt: string
    changed?: 'missing' | 'modified'
  }
}

export interface CliToolView {
  id: string
  name: string
  description?: string
  current: string | null
  status: CliToolStatus
  /** The user turned it off; independent of `revoked`. */
  disabled: boolean
  revoked: boolean
  delisted: boolean
  /** Higher approved catalog version; installing it needs the user's confirmation. */
  catalogUpdate?: string
  /** Holds a version shipped with Halo: the tool can be disabled, not removed. */
  hasPreset: boolean
  /** Commands the current version exposes. */
  commands: string[]
  /** Newest first; the registered program last. */
  versions: CliToolVersionView[]
}

/** off: no trust file; on: signatures required; broken: trust file unusable, catalog installs refused. */
export type CliSignatureMode = 'off' | 'on' | 'broken'

export interface CliToolsOverview {
  /** False when this process has no tool store (e.g. remote web without one). */
  available: boolean
  tools: CliToolView[]
  signature: CliSignatureMode
  /** Removed versions whose files wait for running tasks to finish. */
  pendingCleanup: number
}

/** Machine code of a refused action; the renderer maps it to localized text. */
export type CliToolsErrorCode =
  | 'PACKAGE_INVALID' | 'MANIFEST_INVALID' | 'DIGEST_MISMATCH' | 'PATH_UNSAFE' | 'PLATFORM_UNSUPPORTED'
  | 'NATIVE_NOT_ALLOWED' | 'RUNTIME_KIND_UNSUPPORTED' | 'RUNTIME_VERSION_UNSUPPORTED' | 'RUNTIME_MISSING'
  | 'VERSION_CONFLICT' | 'NOT_FOUND' | 'IN_USE' | 'STATE_CORRUPT' | 'PRESET_PROTECTED' | 'EXTERNAL_INVALID'
  | 'SIGNATURE_MISSING' | 'SIGNATURE_INVALID' | 'EXPIRED' | 'UNEXPECTED'

export type CliToolsResult<T> = { ok: true; data: T } | { ok: false; code: CliToolsErrorCode; message: string }

export interface CliPackagePreviewView {
  previewId: string
  fileName: string
  id: string
  name: string
  description?: string
  version: string
  commands: Array<{ name: string; clash: 'tool' | 'path' | null }>
  platforms: string[]
  minNode?: string
  sideEffects?: 'read-only' | 'writes'
  auth?: 'none' | 'env-ref' | 'external-login'
  archiveBytes: number
  payloadBytes: number
  files: number
  /** The tool is installed with a current version from somewhere. */
  existing: { current: string | null; currentSource: CliToolSourceKind | null } | null
  /** `identical`: already installed; `conflict`: same version, different content. */
  sameVersion: 'identical' | 'conflict' | null
}

export interface CliExternalPick {
  pickId: string
  path: string
  fileName: string
  /** Suggested from the extension: scripts run on Halo's Node. */
  interpreter: 'halo-node' | null
  /** Suggested command name derived from the file name. */
  suggestedCommand: string
}

export interface CliRegisterExternalInput {
  pickId: string
  command: string
  name: string
  description?: string
}
