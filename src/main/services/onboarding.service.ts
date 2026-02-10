/**
 * Onboarding Service - Handle first-time user onboarding data
 */

import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { getSpace } from './space.service'
import { v4 as uuidv4 } from 'uuid'

interface Conversation {
  id: string
  spaceId: string
  title: string
  messages: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: string
  }>
  createdAt: string
  updatedAt: string
}

/**
 * Write the onboarding HTML artifact to the space
 */
export function writeOnboardingArtifact(
  spaceId: string,
  filename: string,
  content: string
): { success: boolean; path?: string; error?: string } {
  const space = getSpace(spaceId)
  if (!space) {
    return { success: false, error: 'Space not found' }
  }

  try {
    // Determine artifacts directory (use workingDir for project-based spaces)
    const baseDir = space.workingDir || space.path
    const artifactsDir = join(baseDir, 'artifacts')

    // Ensure directory exists
    if (!existsSync(artifactsDir)) {
      mkdirSync(artifactsDir, { recursive: true })
    }

    // Write the file
    const filePath = join(artifactsDir, filename)
    writeFileSync(filePath, content, 'utf-8')

    console.log(`[Onboarding] Wrote artifact: ${filePath}`)
    return { success: true, path: filePath }
  } catch (error) {
    console.error('[Onboarding] Failed to write artifact:', error)
    return { success: false, error: (error as Error).message }
  }
}

/**
 * Save the onboarding conversation to the space
 */
export function saveOnboardingConversation(
  spaceId: string,
  userPrompt: string,
  aiResponse: string
): { success: boolean; conversationId?: string; error?: string } {
  const space = getSpace(spaceId)
  if (!space) {
    return { success: false, error: 'Space not found' }
  }

  try {
    // Determine conversations directory
    let conversationsDir: string
    if (space.isTemp) {
      conversationsDir = join(space.path, 'conversations')
    } else {
      conversationsDir = join(space.path, '.halo', 'conversations')
    }

    // Ensure directory exists
    if (!existsSync(conversationsDir)) {
      mkdirSync(conversationsDir, { recursive: true })
    }

    // Create conversation
    const now = new Date().toISOString()
    const conversationId = uuidv4()

    const conversation: Conversation = {
      id: conversationId,
      spaceId,
      title: 'Welcome to Halo',
      messages: [
        {
          id: uuidv4(),
          role: 'user',
          content: userPrompt,
          timestamp: now
        },
        {
          id: uuidv4(),
          role: 'assistant',
          content: aiResponse,
          timestamp: now
        }
      ],
      createdAt: now,
      updatedAt: now
    }

    // Write conversation file
    const filePath = join(conversationsDir, `${conversationId}.json`)
    writeFileSync(filePath, JSON.stringify(conversation, null, 2), 'utf-8')

    console.log(`[Onboarding] Saved conversation: ${filePath}`)
    return { success: true, conversationId }
  } catch (error) {
    console.error('[Onboarding] Failed to save conversation:', error)
    return { success: false, error: (error as Error).message }
  }
}
