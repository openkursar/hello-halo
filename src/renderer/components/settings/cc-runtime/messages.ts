import type { CcCompatibility, CcRuntimeIssue } from '../../../../shared/types/cc-runtime'
import { useTranslation } from '../../../i18n'

export function useCcRuntimeMessages() {
  const { t } = useTranslation()

  const issue = (value?: CcRuntimeIssue): string => {
    switch (value) {
      case 'not-found': return t('Claude Code was not found at this path. Choose its executable or installation folder.')
      case 'not-executable': return t('This file cannot be executed. Check its permissions or choose another installation.')
      case 'unsupported-launcher': return t('Choose the Claude Code executable, its cli.js file, or its installation folder.')
      case 'version-unrecognized': return t('This program did not report a recognized Claude Code version.')
      case 'version-too-old': return t('This version is too old for Halo. Install the recommended version.')
      case 'probe-timeout': return t('The check timed out. Retry the check or choose another installation.')
      case 'probe-busy': return t('Other installation checks are still running. Please try again shortly.')
      case 'protocol-unsupported': return t('This installation does not support the interfaces Halo needs.')
      case 'process-failed': return t('Claude Code could not start. Check the installation and try again.')
      case 'install-busy': return t('An installation is already in progress.')
      case 'invalid-source': return t('Enter an HTTP or HTTPS download source without embedded credentials.')
      case 'invalid-version': return t('Enter a version number such as 2.1.310, or use stable or latest.')
      case 'version-not-found': return t('This download source does not provide that version. Check the version number or choose another source.')
      case 'source-unreachable': return t('The download source could not be reached. Check your connection, proxy or source address, then retry.')
      case 'source-timeout': return t('The download source took too long to respond. Try again or choose another source.')
      case 'source-unauthorized': return t('The download source denied access. Check access with your administrator or choose another source.')
      case 'invalid-manifest': return t('The source did not provide a valid release manifest. Check the source address.')
      case 'unsupported-platform': return t('This release does not include a download for your computer.')
      case 'checksum-mismatch': return t('The download failed its integrity check. Your previous installation has been kept.')
      case 'version-mismatch': return t('The downloaded program does not match the requested version.')
      case 'cancelled': return t('Installation cancelled. Your previous selection has been kept.')
      case 'storage-failed': return t('The installation or settings could not be saved. Check available disk space and permissions.')
      case 'download-failed': return t('The download failed. Check your connection, proxy or download source, then retry.')
      default: return t('The operation could not be completed. Please try again.')
    }
  }

  const compatibility = (state: CcCompatibility): string => {
    switch (state) {
      case 'verified': return t('Verified version')
      case 'compatible': return t('Interface check passed')
      case 'incompatible': return t('Incompatible')
      case 'unavailable': return t('Unavailable')
      case 'unchecked': return t('Not checked yet')
    }
  }

  return { issue, compatibility }
}
