import type { ToolDiscoveryOptions } from '../../types/config.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Snapshot host policy at creation; it contains no connections or executable callbacks. */
export function snapshotToolDiscoveryOptions(value: ToolDiscoveryOptions | undefined): ToolDiscoveryOptions | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).some(key => key !== 'services') || !record(value.services)) {
    throw new TypeError('toolDiscovery requires a services object');
  }
  for (const policy of Object.values(value.services)) {
    if (!record(policy) || Object.keys(policy).some(key =>
      !['identity', 'loading', 'summary', 'usageGuide', 'toolOverrides'].includes(key)) ||
      typeof policy.identity !== 'string' || !policy.identity.trim() ||
      (policy.loading !== 'eager' && policy.loading !== 'deferred') ||
      (policy.summary !== undefined && typeof policy.summary !== 'string') ||
      (policy.usageGuide !== undefined && typeof policy.usageGuide !== 'string') ||
      (policy.toolOverrides !== undefined && (!record(policy.toolOverrides) ||
        Object.values(policy.toolOverrides).some(mode => mode !== 'eager' && mode !== 'deferred')))) {
      throw new TypeError('Invalid tool discovery service policy');
    }
  }
  return structuredClone(value);
}
