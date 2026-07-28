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
  getOfficialRegistryUrl,
  addRegistry,
  removeRegistry,
  toggleRegistry,
  updateRegistryAdapterConfig,
} from './registry.service'

export { checkNow as checkUpgradesNow, startUpgradeScheduler, stopUpgradeScheduler } from './upgrade.service'

export { publish, collectFiles, getPublishPreview } from './publish'
export { pack as packDhpkg, unpack as unpackDhpkg } from './dhpkg'
export { getMarketplaceCapabilities } from './marketplace-capabilities'
export { getCategoryTaxonomy, invalidateServerTaxonomyCache } from './marketplace-taxonomy'
export { getDiscoverLayout, invalidateDiscoverLayoutCache } from './marketplace-discover'
export { fetchMyPublications, unpublishApp, relistApp } from './marketplace-mine'
export { ensureMarketplaceIdentity, getMarketplaceIdentity, getMarketplaceSignInStatus } from './marketplace-identity'
export { fetchCollections } from './marketplace-collections'
