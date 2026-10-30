import { DEFAULT_MAX_TURNS } from '../../shared/constants/agent-limits'
import type { CcInstallRequest, CcRuntimeStatus } from '../../shared/types/cc-runtime'
import { getConfig, getAgentEngineChoiceRevision, onAgentConfigChange, saveConfig } from '../foundation/config.service'
import { CcRuntimeError, configureCcRuntime, getCcRuntimeStatus, installCcRuntime, selectCcInstallation } from '../services/cc-runtime'
import type { CcRuntimeResponse } from '../../shared/rpc/contracts/cc-runtime.contract'
import { getDefaultEngine } from '../services/agent'
import { isEngineId } from '../../shared/types/engine'

export async function ccRuntimeResponse<T>(activity: string, operation: () => T | Promise<T>): Promise<CcRuntimeResponse<T>> {
  try { return { success: true, data: await operation() } }
  catch (error) {
    if (error instanceof CcRuntimeError) return { success: false, issue: error.code, error: error.message }
    console.error(`[CcRuntime] ${activity} failed unexpectedly:`, error)
    return { success: false, error: 'Claude Code operation failed' }
  }
}

/** Installation intent survives a closed settings panel, but never supersedes a later engine choice. */
async function useWhenReady(operation: () => Promise<unknown>): Promise<CcRuntimeStatus> {
  const requested = getConfig().agent?.sdkEngine ?? 'halo'
  const choiceRevision = getAgentEngineChoiceRevision()
  let superseded = false
  const unsubscribe = onAgentConfigChange(agent => {
    if ((agent?.sdkEngine ?? 'halo') !== requested) superseded = true
  })
  try {
    await operation()
    const current = getConfig().agent
    if (!superseded && getAgentEngineChoiceRevision() === choiceRevision && (current?.sdkEngine ?? 'halo') === requested) {
      const baseline = requested !== 'anthropic' && !isEngineId(current?.legacySdkEngine) ? { legacySdkEngine: getDefaultEngine() } : {}
      saveConfig({ agent: { ...current, ...baseline, maxTurns: current?.maxTurns ?? DEFAULT_MAX_TURNS, sdkEngine: 'anthropic' } })
      if (getConfig().agent?.sdkEngine !== 'anthropic') throw new CcRuntimeError('storage-failed')
      console.log('[CcRuntime] Checked installation selected as the default for new sessions')
    } else {
      console.log('[CcRuntime] Installation ready; preserving the newer engine preference')
    }
    return getCcRuntimeStatus()
  } finally { unsubscribe() }
}

export function selectCcRuntimeForUse(path: string): Promise<CcRuntimeStatus> {
  return useWhenReady(() => selectCcInstallation(path))
}

export function installCcRuntimeForUse(request: CcInstallRequest): Promise<CcRuntimeStatus> {
  return useWhenReady(async () => {
    if (request.preferences) await configureCcRuntime(request.preferences)
    return installCcRuntime(request)
  })
}
