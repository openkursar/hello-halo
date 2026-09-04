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
  getRegistryById,
  getPrimaryRegistry,
} from './registry.service'

export { checkNow as checkUpgradesNow, startUpgradeScheduler, stopUpgradeScheduler } from './upgrade.service'

export { publish, collectFiles, inspectSkillDeps, getPublishPreview, findAppByPublishSlug } from './publish'
export type { SkillDepInspection } from './publish'
export { pack as packDhpkg, unpack as unpackDhpkg } from './dhpkg'
export { packSkill } from './skill-pkg'
export { getStoreCapabilities } from './backend/capabilities'
export { getCategoryTaxonomy, invalidateServerTaxonomyCache } from './backend/taxonomy'
export { getDiscoverLayout, invalidateDiscoverLayoutCache } from './backend/discover'
export { getDiscoverPage } from './discover-page'
export { fetchMyPublications, unpublishApp } from './backend/publications'
export { ensureStoreIdentity, getStoreIdentity, getStoreSignInStatus } from './backend/identity'
export { fetchCollections } from './backend/collections'
export { flushPendingInstallOrders } from './backend/install-orders'
