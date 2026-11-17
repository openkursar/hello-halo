import type { CcInstallRequest, CcRuntimePreferences } from '../../../shared/types/cc-runtime'
import { getRuntime } from '../external-runtime'
export const getCcRuntimeStatus = () => getRuntime('anthropic').getStatus()
export const configureCcRuntime = (preferences: CcRuntimePreferences) => getRuntime('anthropic').configure(preferences)
export const scanCcInstallations = () => getRuntime('anthropic').scan()
export const probeCcInstallation = (path: string) => getRuntime('anthropic').probeInstallation(path)
export const lookupCcRelease = (request: CcInstallRequest = {}) => getRuntime('anthropic').lookup(request)
export const selectCcInstallation = (path: string) => getRuntime('anthropic').select(path)
export const resolveCcRuntimeLaunch = (options: { deadlineMs?: number; signal?: AbortSignal } = {}) => getRuntime('anthropic').resolveLaunch(options)
export const installCcRuntime = (request: CcInstallRequest = {}) => getRuntime('anthropic').install(request)
export const cancelCcInstall = () => getRuntime('anthropic').cancel()
export const shutdownCcRuntime = () => getRuntime('anthropic').shutdown()
