/**
 * Onboarding IPC Handlers
 *
 * Registered from the typed RPC contract (passthrough): channel names + arg
 * types live in `shared/rpc/contracts/onboarding`; handler bodies are
 * preserved verbatim and their return shapes reach the renderer unchanged.
 */

import {
  writeOnboardingArtifact,
  saveOnboardingConversation,
} from '../services/onboarding.service'
import { onboardingRpc } from '../../shared/rpc/contracts/onboarding.contract'
import { registerRawRpcHandlers } from './rpc'

export function registerOnboardingHandlers(): void {
  registerRawRpcHandlers(onboardingRpc, {
    writeOnboardingArtifact: (spaceId, filename, content) => {
      console.log('[Settings] onboarding:write-artifact - Writing:', filename, 'to space:', spaceId)
      try {
        const result = writeOnboardingArtifact(spaceId, filename, content)
        console.log('[Settings] onboarding:write-artifact - Written successfully')
        return result
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] onboarding:write-artifact - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },
    saveOnboardingConversation: (spaceId, userPrompt, aiResponse) => {
      console.log('[Settings] onboarding:save-conversation - Saving to space:', spaceId)
      try {
        const result = saveOnboardingConversation(spaceId, userPrompt, aiResponse)
        console.log('[Settings] onboarding:save-conversation - Saved successfully')
        return result
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] onboarding:save-conversation - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },
  })

  console.log('[Settings] Onboarding handlers registered')
}
