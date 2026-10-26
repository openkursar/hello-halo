// External runtime selection and provisioning; no engine sessions or automatic discovery.
export {
  getCcRuntimeStatus, configureCcRuntime, scanCcInstallations, probeCcInstallation,
  selectCcInstallation, resolveCcRuntimeLaunch, discoverAndSelectCcRuntime,
  installCcRuntime, cancelCcInstall, shutdownCcRuntime, lookupCcRelease
} from './service'
export { CcRuntimeError } from './errors'
export type {
  CcCompatibility, CcDownloadSource, CcInstallation, CcInstallProgress, CcInstallRequest,
  CcRuntimeConfig, CcRuntimeIssue, CcRuntimeLaunch, CcRuntimePreferences, CcRuntimeStatus, CcScanResult, CcReleaseInfo
} from '../../../shared/types/cc-runtime'
