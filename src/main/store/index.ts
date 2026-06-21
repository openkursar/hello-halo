/** Registry service for discovering, browsing, installing, and publishing apps. */

export {
  initRegistryService,
  shutdownRegistryService,
  onSyncStatusChanged,
  onUpgradeAvailable,
  refreshIndex,
  queryStore,
  listApps,
  getAppDetail,
  getAppDocument,
  installFromStore,
  checkUpdates,
  applyUpgrade,
  getRegistries,
  addRegistry,
  removeRegistry,
  toggleRegistry,
  updateRegistryAdapterConfig,
} from './registry.service'

export { checkNow as checkUpgradesNow, startUpgradeScheduler, stopUpgradeScheduler } from './upgrade.service'

export { publish, collectFiles, getPublishPreview } from './publish'
export { pack as packDhpkg, unpack as unpackDhpkg } from './dhpkg'
