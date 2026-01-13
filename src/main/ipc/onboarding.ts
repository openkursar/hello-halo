/**
 * Onboarding IPC Handlers
 */

import { ipcMain } from 'electron'
import {
  writeOnboardingArtifact,
  saveOnboardingConversation
} from '../services/onboarding.service'

export function registerOnboardingHandlers(): void {
  // Write onboarding artifact (HTML file)
  ipcMain.handle(
    'onboarding:write-artifact',
    async (_event, spaceId: string, filename: string, content: string) => {
      try {
        const result = writeOnboardingArtifact(spaceId, filename, content)
        return result
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    }
  )

  // Save onboarding conversation
  ipcMain.handle(
    'onboarding:save-conversation',
    async (_event, spaceId: string, userPrompt: string, aiResponse: string) => {
      try {
        const result = saveOnboardingConversation(spaceId, userPrompt, aiResponse)
        return result
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    }
  )
}
