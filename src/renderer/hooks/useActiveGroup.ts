/**
 * The load-balancing group the conversation (or digital human) on screen runs
 * on, if it runs on one rather than on a single account.
 */

import { useAppStore } from '../stores/app.store'
import { useActiveModelTarget } from './useActiveModelTarget'
import { resolveModelSelection, type AIGroup } from '../types'

export function useActiveGroup(): AIGroup | null {
  const target = useActiveModelTarget()
  const aiSources = useAppStore(state => state.config?.aiSources)
  if (!aiSources || aiSources.version !== 2) return null
  return resolveModelSelection(aiSources, target.kind === 'conversation' ? target.conversation : target).group ?? null
}
