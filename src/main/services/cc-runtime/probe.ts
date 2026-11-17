import { getRuntime } from '../external-runtime'
export const checkInstallation = (path: string, options: { force?: boolean; signal?: AbortSignal } = {}) => getRuntime('anthropic').probe.checkInstallation(path, options)
export const launchForInstallation = (path: string, options: { signal?: AbortSignal } = {}) => getRuntime('anthropic').probe.launchForInstallation(path, options)
export const readKnownInstallation = (path: string) => getRuntime('anthropic').probe.readKnownInstallation(path)
export const shutdownProbes = () => getRuntime('anthropic').probe.shutdownProbes()
