/**
 * Store (App Registry) RPC contract (passthrough). Channels preserve their
 * existing return shapes verbatim. `store:install` is excluded: its preload
 * binding wraps a progress-event listener around the invoke and cannot be
 * expressed as a one-line passthrough.
 */
import { rawRpcMethod } from '../define'

export const storeRpc = {
  storeQuery: rawRpcMethod('store:query'),
  storeListApps: rawRpcMethod('store:list-apps'),
  storeGetAppDetail: rawRpcMethod('store:get-app-detail'),
  storeRefresh: rawRpcMethod('store:refresh'),
  storeCheckUpdates: rawRpcMethod('store:check-updates'),
  storeGetRegistries: rawRpcMethod('store:get-registries'),
  storeAddRegistry: rawRpcMethod('store:add-registry'),
  storeRemoveRegistry: rawRpcMethod('store:remove-registry'),
  storeToggleRegistry: rawRpcMethod('store:toggle-registry'),
  storeUpdateRegistryAdapterConfig: rawRpcMethod('store:update-registry-adapter-config'),
  storeCheckUpdatesNow: rawRpcMethod('store:check-updates-now'),
  storeApplyUpgrade: rawRpcMethod('store:apply-upgrade'),
  storePublish: rawRpcMethod('store:publish'),
  storePublishPreview: rawRpcMethod('store:publish-preview'),
  storeInspectSkillDeps: rawRpcMethod('store:inspect-skill-deps'),
  storeInspectSkillDepsForSpec: rawRpcMethod('store:inspect-skill-deps-for-spec'),
  storeFindAppByPublishSlug: rawRpcMethod('store:find-app-by-publish-slug'),
  storeExportDhpkg: rawRpcMethod('store:export-dhpkg'),
  storeExportSkill: rawRpcMethod('store:export-skill'),
  storeImportDhpkg: rawRpcMethod('store:import-dhpkg'),
  storeGetCapabilities: rawRpcMethod('store:get-capabilities'),
  storeGetCategoryTaxonomy: rawRpcMethod('store:get-category-taxonomy'),
  storeGetDiscoverPage: rawRpcMethod('store:get-discover-page'),
  storeRevalidate: rawRpcMethod('store:revalidate'),
  storeEnsureSignedIn: rawRpcMethod('store:ensure-signed-in'),
  storeGetIdentity: rawRpcMethod('store:get-identity'),
  storeGetSignInStatus: rawRpcMethod('store:get-sign-in-status'),
  storeGetMyPublications: rawRpcMethod('store:get-my-publications'),
  storeUnpublish: rawRpcMethod('store:unpublish'),
  storeIgnoreVersion: rawRpcMethod('store:ignore-version'),
}
