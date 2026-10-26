import { getConfig, saveConfig } from '../../foundation/config.service'
import { DEFAULT_MAX_TURNS } from '../../../shared/constants/agent-limits'

/** One bounded attempt to preserve an old, explicit CC choice after removing the bundled runtime. */
export async function migrateCcRuntimeSelection(): Promise<void> {
  const agent = getConfig().agent
  if (agent?.sdkEngine !== 'anthropic' || agent.ccRuntime?.selectedPath || agent.ccRuntime?.discoveryCompleted) return
  const started = Date.now()
  try {
    const { discoverAndSelectCcRuntime } = await import('../cc-runtime')
    const selected = await discoverAndSelectCcRuntime({ deadlineMs: 8_000 })
    console.log(`[SDK] External CC migration completed outcome=${selected ? 'selected' : 'halo-fallback'} durationMs=${Date.now() - started}`)
  } catch (error) {
    console.warn('[SDK] External CC migration failed; continuing with Halo:', error)
  }
  const current = getConfig().agent
  try {
    saveConfig({ agent: {
      ...current, maxTurns: current?.maxTurns ?? DEFAULT_MAX_TURNS,
      ccRuntime: { ...current?.ccRuntime, discoveryCompleted: true },
    } })
    if (!getConfig().agent?.ccRuntime?.discoveryCompleted) throw new Error('CC discovery marker was not persisted')
  } catch (error) {
    console.warn('[SDK] External CC migration marker could not be saved; discovery may repeat next launch:', error)
  }
}
