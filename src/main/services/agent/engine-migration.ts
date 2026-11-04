import { getConfig } from '../../foundation/config.service'
import type { EngineId } from '../../../shared/types/engine'
import { hasExplicitCcSelection } from '../../../shared/types/cc-runtime'

/** Old defaults and automatically selected paths do not establish user intent. */
export function resolveHistoricalEngine(engineId: EngineId): EngineId {
  const config = getConfig()
  return engineId === 'anthropic' && !hasExplicitCcSelection(config.agent?.ccRuntime, config.aiSources)
    ? 'halo'
    : engineId
}
