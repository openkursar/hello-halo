import { getRuntime } from '../external-runtime'
export { mergeInstallationSnapshot } from '../external-runtime'
export type { CatalogEntry, CatalogIntegrity } from '../external-runtime'

export const getCatalogSnapshot = () => getRuntime('anthropic').catalog.getCatalogSnapshot()
export const getManagedCatalogEntries = (version: string, platform: string) => getRuntime('anthropic').catalog.getManagedCatalogEntries(version, platform)
export const getCatalogEntry = (path: string) => getRuntime('anthropic').catalog.getCatalogEntry(path)
export const rememberInstallation: ReturnType<typeof getRuntime>['catalog']['rememberInstallation'] = (...args) => getRuntime('anthropic').catalog.rememberInstallation(...args)
