/** Localized labels for the local command-line tool manager. */

import type { CliToolsErrorCode, CliToolSourceKind, CliToolStatus } from '../../../shared/types/cli-tools'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** Localized reason for a refused action. Unknown codes fall back to the server text. */
export function cliToolsErrorText(t: Translate, code: CliToolsErrorCode, message: string): string {
  switch (code) {
    case 'PACKAGE_INVALID': return t('The package is damaged or not a Halo CLI package (.hcli). It may also contain install scripts, which are not allowed.')
    case 'MANIFEST_INVALID': return t('The package description (manifest) is invalid, or the package declares install scripts, which are not allowed.')
    case 'DIGEST_MISMATCH': return t('The package content does not match its recorded digest. It may have been altered.')
    case 'PATH_UNSAFE': return t('The package contains a file path that escapes its folder, or a link. It was rejected.')
    case 'PLATFORM_UNSUPPORTED': return t('The package does not support this operating system or processor.')
    case 'NATIVE_NOT_ALLOWED': return t('The package contains native modules or install scripts, which are not allowed.')
    case 'RUNTIME_KIND_UNSUPPORTED': return t('The package needs a runtime Halo does not provide.')
    case 'RUNTIME_VERSION_UNSUPPORTED': return t('The package needs a newer Node.js than the one bundled with Halo.')
    case 'RUNTIME_MISSING': return t('Command-line tools are not available in this window.')
    case 'VERSION_CONFLICT': return t('This version number is already installed with different content. Versions are immutable: ask the publisher for a new version number, or delete the installed one first.')
    case 'NOT_FOUND': return t('The tool or version no longer exists, or the program file is missing.')
    case 'IN_USE': return t('This is the current version. Choose another version first, or remove the whole tool.')
    case 'STATE_CORRUPT': return t('The local tool records could not be read.')
    case 'PRESET_PROTECTED': return t('This version ships with Halo and cannot be deleted. You can disable the tool instead.')
    case 'EXTERNAL_INVALID': return t('The program could not be registered: {{reason}}', { reason: message })
    case 'SIGNATURE_MISSING': return t('This catalog version has no enterprise signature, and this build requires one.')
    case 'SIGNATURE_INVALID': return t('The enterprise signature of this catalog version is not valid. It was not installed.')
    case 'EXPIRED': return t('The selection expired. Choose the file again.')
    default: return message || t('Something went wrong. Please try again.')
  }
}

export function sourceLabel(t: Translate, source: CliToolSourceKind): string {
  if (source === 'preset') return t('Shipped with Halo')
  if (source === 'catalog') return t('Enterprise catalog')
  if (source === 'user-import') return t('Imported by you')
  return t('Existing program')
}

export function statusLabel(t: Translate, status: CliToolStatus): string {
  switch (status) {
    case 'available': return t('Available')
    case 'disabled': return t('Disabled')
    case 'revoked': return t('Revoked')
    case 'delisted': return t('Removed from catalog')
    case 'external-changed': return t('Program changed')
    default: return t('No current version')
  }
}

export function statusClass(status: CliToolStatus): string {
  if (status === 'available') return 'bg-halo-success/10 text-halo-success'
  if (status === 'disabled' || status === 'no-current') return 'bg-secondary text-muted-foreground'
  if (status === 'external-changed') return 'bg-halo-warning/10 text-halo-warning'
  return 'bg-halo-error/5 text-halo-error'
}

