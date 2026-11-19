/**
 * Typed failures of the CLI tool store. Callers branch on `code`, never on the
 * message text; messages are for logs and carry no credentials or file contents.
 */

export type CliToolErrorCode =
  /** The archive is unreadable, not a package, too large or has an unknown layout. */
  | 'PACKAGE_INVALID'
  /** manifest.json is missing or does not satisfy the `halo.cli/1` schema. */
  | 'MANIFEST_INVALID'
  /** The archive or payload digest differs from the one that was expected. */
  | 'DIGEST_MISMATCH'
  /** An entry path escapes the package, is absolute, or collides case-insensitively. */
  | 'PATH_UNSAFE'
  /** The package does not declare the current platform-architecture. */
  | 'PLATFORM_UNSUPPORTED'
  /** The payload contains native code, an install script or a platform-specific package. */
  | 'NATIVE_NOT_ALLOWED'
  /** `runtime.kind` is reserved but not supported by this build (e.g. `binary`). */
  | 'RUNTIME_KIND_UNSUPPORTED'
  /** The bundled runtime is older than the package's `runtime.minNode`. */
  | 'RUNTIME_VERSION_UNSUPPORTED'
  /** The runtime executable a shim would launch does not exist. */
  | 'RUNTIME_MISSING'
  /** The same id and version is already installed with different content. */
  | 'VERSION_CONFLICT'
  /** The requested tool or version is not installed. */
  | 'NOT_FOUND'
  /** The version is current or pinned by a running execution and cannot be removed. */
  | 'IN_USE'
  /** state.json exists but cannot be parsed; it is never silently reset. */
  | 'STATE_CORRUPT'
  /** A version shipped with the build can be disabled but not deleted. */
  | 'PRESET_PROTECTED'
  /** An existing program cannot be registered: path, interpreter or command name is unusable. */
  | 'EXTERNAL_INVALID'
  /** Signature checking is on and the catalog version carries no signature. */
  | 'SIGNATURE_MISSING'
  /** The catalog signature is malformed, from an untrusted key, or does not verify. */
  | 'SIGNATURE_INVALID'

export class CliToolError extends Error {
  readonly code: CliToolErrorCode

  constructor(code: CliToolErrorCode, message: string) {
    super(message)
    this.name = 'CliToolError'
    this.code = code
  }
}

export function isCliToolError(err: unknown): err is CliToolError {
  return err instanceof CliToolError
}
