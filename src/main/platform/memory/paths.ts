/**
 * platform/memory -- Path Resolution
 *
 * Maps (caller, scope) pairs to filesystem paths. The single source of truth
 * for where memory lives.
 *
 *   user-memory:   {haloDir}/user-memory.md          + {haloDir}/user-memory/
 *   space-memory:  {spacePath}/.halo/memory.md       + {spacePath}/.halo/memory/
 *   app-memory:    {appDataPath}/memory.md           + {appDataPath}/memory/
 *                  (appDataPath defaults to {spacePath}/.halo/apps/{appId})
 *
 * Inside the data directory:
 *   topics/          topic wiki, written by the agent
 *   run/             one record per automation run, written by the system
 *   archive/         memory.md as it stood before each consolidation
 *   .snapshots/      memory.md + topics/ before each consolidation (restorable)
 *   .consolidation/  a consolidation's private working copy while it runs
 *   .state.json      when it was last consolidated, and whether it is cooling down
 *
 * Compaction archives written before archive/ existed sit directly in the data
 * directory; they are left where they are.
 */

import { join } from 'path'
import { getHaloDir } from '../../foundation/config.service'
import type { MemoryCallerScope, MemoryScopeType } from './types'

/**
 * Every path one memory owns. Resolved once per use so no caller composes a
 * memory path by hand.
 */
export interface MemoryLayout {
  /** memory.md — `# now` + `# History` */
  file: string
  /** The data directory next to it */
  dataDir: string
  topicsDir: string
  runDir: string
  archiveDir: string
  snapshotsDir: string
  consolidationDir: string
  /** System bookkeeping: last consolidation, cooldown */
  stateFile: string
}

/**
 * Get the base directory for a given memory scope: where memory.md lives.
 *
 * @throws If the scope requires an appId but none is provided
 */
export function getMemoryBaseDir(caller: MemoryCallerScope, scope: MemoryScopeType): string {
  switch (scope) {
    case 'user':
      return getHaloDir()

    case 'space':
      return join(caller.spacePath, '.halo')

    case 'app': {
      if (!caller.appId) {
        throw new Error('Memory scope "app" requires an appId in the caller scope')
      }
      return caller.appDataPath ?? join(caller.spacePath, '.halo', 'apps', caller.appId)
    }

    default:
      throw new Error(`Unknown memory scope: ${scope as string}`)
  }
}

/** Resolve every path of one memory. */
export function resolveMemoryLayout(caller: MemoryCallerScope, scope: MemoryScopeType): MemoryLayout {
  const baseDir = getMemoryBaseDir(caller, scope)
  // The user scope shares its directory with the rest of Halo's data, so its
  // files carry a prefix that keeps them recognisable there.
  const file = join(baseDir, scope === 'user' ? 'user-memory.md' : 'memory.md')
  const dataDir = join(baseDir, scope === 'user' ? 'user-memory' : 'memory')
  return {
    file,
    dataDir,
    topicsDir: join(dataDir, 'topics'),
    runDir: join(dataDir, 'run'),
    archiveDir: join(dataDir, 'archive'),
    snapshotsDir: join(dataDir, '.snapshots'),
    consolidationDir: join(dataDir, '.consolidation'),
    stateFile: join(dataDir, '.state.json'),
  }
}

/** Path to memory.md for a scope. */
export function getMemoryFilePath(caller: MemoryCallerScope, scope: MemoryScopeType): string {
  return resolveMemoryLayout(caller, scope).file
}
