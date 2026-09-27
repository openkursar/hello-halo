/**
 * Where an installed resource came from, for the capability walls' source
 * filter. Shared so the Skill and MCP walls cannot disagree about what
 * "built in" covers.
 */

import type { InstalledApp } from '../../shared/apps/app-types'

export type InstallSourceFilter = 'all' | 'store' | 'manual' | 'builtin'

/** Records written before `install_source` existed mean 'store' (spec-types.ts). */
function installSourceOf(app: InstalledApp): string {
  return app.spec.store?.install_source ?? 'store'
}

export function matchesInstallSource(app: InstalledApp, filter: InstallSourceFilter): boolean {
  if (filter === 'all') return true
  const source = installSourceOf(app)
  // Built-in resources ship two ways: seeded from resources/builtin-apps
  // ('bundled') and registered by the core ('builtin'). One filter entry.
  if (filter === 'builtin') return source === 'builtin' || source === 'bundled'
  return source === filter
}
