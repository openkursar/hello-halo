import type { RuntimeId, RuntimeInstallRequest, RuntimePreferences } from '../../../shared/types/external-runtime';
import { getRuntime } from './registry';
export { getRuntime, shutdownExternalRuntimes } from './registry';
export { RuntimeError, RuntimeError as ExternalRuntimeError, RuntimeError as CcRuntimeError, issueFromError } from './errors';
export { mergeInstallationSnapshot } from './catalog';
export type { CatalogEntry, CatalogIntegrity } from './catalog';
export type * from '../../../shared/types/external-runtime';
export function getExternalRuntimeStatus(runtimeId: RuntimeId) {
  return getRuntime(runtimeId).getStatus();
}
export function configureExternalRuntime(runtimeId: RuntimeId, preferences: RuntimePreferences) {
  return getRuntime(runtimeId).configure(preferences);
}
export function scanExternalRuntime(runtimeId: RuntimeId) {
  return getRuntime(runtimeId).scan();
}
export function probeExternalRuntime(runtimeId: RuntimeId, path: string) {
  return getRuntime(runtimeId).probeInstallation(path);
}
export function selectExternalRuntime(runtimeId: RuntimeId, path: string) {
  return getRuntime(runtimeId).select(path);
}
export function lookupExternalRuntime(runtimeId: RuntimeId, request: RuntimeInstallRequest = {}) {
  return getRuntime(runtimeId).lookup(request);
}
export function installExternalRuntime(runtimeId: RuntimeId, request: RuntimeInstallRequest = {}) {
  return getRuntime(runtimeId).install(request);
}
export function cancelExternalRuntime(runtimeId: RuntimeId) {
  return getRuntime(runtimeId).cancel();
}
export function resolveExternalRuntimeLaunch(runtimeId: RuntimeId, options: {
  deadlineMs?: number;
  signal?: AbortSignal;
} = {}) {
  return getRuntime(runtimeId).resolveLaunch(options);
}
