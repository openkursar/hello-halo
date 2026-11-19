import { DEFAULT_MAX_TURNS } from '../../shared/constants/agent-limits'
import type { RuntimeId, RuntimeInstallRequest, RuntimeStatus } from '../../shared/types/external-runtime'
import type { ExternalRuntimeResponse } from '../../shared/rpc/contracts/external-runtime.contract'
import { isEngineId } from '../../shared/types/engine'
import {
  getConfig, getAgentEngineChoiceRevision, onAgentConfigChange,
  recordAgentEngineChoice, saveConfig,
} from '../foundation/config.service'
import {
  RuntimeError, getExternalRuntimeStatus, installExternalRuntime, selectExternalRuntime,
} from '../services/external-runtime'
import { getDefaultEngine } from '../services/agent'

export function assertRuntimeId(value: unknown): asserts value is RuntimeId {
  if (value !== 'anthropic' && value !== 'codex') throw new RuntimeError('unsupported-platform')
}

export async function externalRuntimeResponse<T>(activity: string, operation: () => T | Promise<T>): Promise<ExternalRuntimeResponse<T>> {
  try { return { success: true, data: await operation() } }
  catch (error) {
    if (error instanceof RuntimeError) return { success: false, issue: error.code, error: error.message }
    console.error('[ExternalRuntime] Operation failed unexpectedly', { activity, name: error instanceof Error ? error.name : 'unknown' })
    return { success: false, error: 'Runtime operation failed' }
  }
}

export function recordExternalRuntimeIntent(runtimeId: RuntimeId): void {
  assertRuntimeId(runtimeId)
  recordAgentEngineChoice()
}

async function useWhenReady(runtimeId: RuntimeId, operation: () => Promise<unknown>): Promise<RuntimeStatus> {
  assertRuntimeId(runtimeId)
  recordAgentEngineChoice()
  const choiceRevision = getAgentEngineChoiceRevision()
  const requested = getConfig().agent?.sdkEngine ?? 'halo'
  let superseded = false
  const unsubscribe = onAgentConfigChange(agent => {
    if ((agent?.sdkEngine ?? 'halo') !== requested) superseded = true
  })
  try {
    await operation()
    const current = getConfig().agent
    if (!superseded && getAgentEngineChoiceRevision() === choiceRevision && (current?.sdkEngine ?? 'halo') === requested) {
      const baseline = requested !== runtimeId && !isEngineId(current?.legacySdkEngine) ? { legacySdkEngine: getDefaultEngine() } : {}
      saveConfig({ agent: { ...current, ...baseline, maxTurns: current?.maxTurns ?? DEFAULT_MAX_TURNS, sdkEngine: runtimeId } })
      if (getConfig().agent?.sdkEngine !== runtimeId) throw new RuntimeError('storage-failed')
      console.log('[ExternalRuntime] Checked installation selected as the default for new sessions', { runtimeId })
    } else {
      console.log('[ExternalRuntime] Installation ready; preserving the newer engine preference', { runtimeId })
    }
    return getExternalRuntimeStatus(runtimeId)
  } finally { unsubscribe() }
}

export function selectExternalRuntimeForUse(runtimeId: RuntimeId, path: string): Promise<RuntimeStatus> {
  return useWhenReady(runtimeId, () => selectExternalRuntime(runtimeId, path))
}

export function installExternalRuntimeForUse(runtimeId: RuntimeId, request: RuntimeInstallRequest): Promise<RuntimeStatus> {
  return useWhenReady(runtimeId, () => installExternalRuntime(runtimeId, request))
}
