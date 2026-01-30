/**
 * Feishu Controller - Business logic for Feishu bot integration
 * Handles webhook events and message relay to Agent
 */

import { BrowserWindow } from 'electron'
import { sendMessage as agentSendMessage } from '../services/agent.service'
import { getMainWindow } from '../http/server'
import { getConfig, saveConfig } from '../services/config.service'
import { createConversation, getConversation } from '../services/conversation.service'

// Feishu API endpoints
const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis'

// Token cache
let tokenCache: { token: string; expiresAt: number } | null = null

export interface FeishuConfig {
  appId: string
  appSecret: string
  enabled: boolean
}

export interface ControllerResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// Feishu event types
export interface FeishuMessageEvent {
  schema: string
  header: {
    event_id: string
    event_type: string
    create_time: string
    token: string
    app_id: string
    tenant_key: string
  }
  event: {
    sender: {
      sender_id: {
        open_id: string
        user_id?: string
        union_id?: string
      }
      sender_type: string
      tenant_key: string
    }
    message: {
      message_id: string
      root_id?: string
      parent_id?: string
      create_time: string
      chat_id: string
      chat_type: string
      message_type: string
      content: string
    }
  }
}

// Session mapping: Feishu chat_id -> Halo conversation
interface FeishuSession {
  spaceId: string
  conversationId: string
  chatId: string
  lastMessageId?: string
}

// In-memory session store (consider persisting for production)
const feishuSessions = new Map<string, FeishuSession>()

// Processed event IDs to prevent duplicates
const processedEvents = new Set<string>()
const MAX_PROCESSED_EVENTS = 1000

/**
 * Get Feishu configuration from config file
 */
export function getFeishuConfig(): FeishuConfig {
  const config = getConfig()
  const feishuConfig = {
    appId: config.feishu?.appId || '',
    appSecret: config.feishu?.appSecret || '',
    enabled: config.feishu?.enabled || false
  }
  console.log(`[Feishu] getFeishuConfig: enabled=${feishuConfig.enabled}, raw=${config.feishu?.enabled}`)
  return feishuConfig
}

/**
 * Save Feishu configuration to config file
 */
export function saveFeishuConfig(feishuConfig: Partial<FeishuConfig>): ControllerResponse {
  try {
    console.log(`[Feishu] saveFeishuConfig called with:`, JSON.stringify(feishuConfig))
    const config = getConfig()
    const newConfig = {
      ...config,
      feishu: {
        appId: feishuConfig.appId ?? config.feishu?.appId ?? '',
        appSecret: feishuConfig.appSecret ?? config.feishu?.appSecret ?? '',
        enabled: feishuConfig.enabled ?? config.feishu?.enabled ?? false
      }
    }
    console.log(`[Feishu] Saving config with feishu.enabled=${newConfig.feishu.enabled}`)
    saveConfig(newConfig)
    // Clear token cache when config changes
    tokenCache = null
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

/**
 * Check if Feishu integration is configured
 */
export function isFeishuConfigured(): boolean {
  const config = getFeishuConfig()
  return !!(config.appId && config.appSecret)
}

/**
 * Get tenant access token from Feishu
 */
export async function getTenantAccessToken(): Promise<string> {
  const config = getFeishuConfig()

  // Return cached token if valid
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token
  }

  const response = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret
    })
  })

  const data = await response.json() as {
    code: number
    msg: string
    tenant_access_token: string
    expire: number
  }

  if (data.code !== 0) {
    throw new Error(`Failed to get access token: ${data.msg}`)
  }

  // Cache token with 5 minute buffer
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire - 300) * 1000
  }

  return data.tenant_access_token
}

/**
 * Send message to Feishu chat
 */
export async function sendFeishuMessage(
  chatId: string,
  content: string,
  messageType: 'text' | 'post' = 'text'
): Promise<ControllerResponse> {
  try {
    console.log(`[Feishu] Sending message to chat: ${chatId}, content length: ${content.length}`)
    const token = await getTenantAccessToken()
    console.log(`[Feishu] Got access token: ${token.substring(0, 10)}...`)

    const payload = messageType === 'text'
      ? { text: content }
      : content

    const requestBody = {
      receive_id: chatId,
      msg_type: messageType,
      content: JSON.stringify(payload)
    }
    console.log(`[Feishu] Request body:`, JSON.stringify(requestBody).substring(0, 200))

    const response = await fetch(
      `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=chat_id`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(requestBody)
      }
    )

    const data = await response.json() as { code: number; msg: string; data?: unknown }
    console.log(`[Feishu] API response:`, JSON.stringify(data).substring(0, 300))

    if (data.code !== 0) {
      console.error(`[Feishu] API error: code=${data.code}, msg=${data.msg}`)
      return { success: false, error: `Feishu API error: ${data.msg}` }
    }

    console.log(`[Feishu] Message sent successfully`)
    return { success: true }
  } catch (error) {
    console.error(`[Feishu] Send message error:`, error)
    return { success: false, error: (error as Error).message }
  }
}

/**
 * Handle URL verification challenge from Feishu
 */
export function handleUrlVerification(challenge: string): ControllerResponse<{ challenge: string }> {
  return { success: true, data: { challenge } }
}

/**
 * Check if event was already processed (deduplication)
 */
function isEventProcessed(eventId: string): boolean {
  if (processedEvents.has(eventId)) {
    return true
  }

  // Add to processed set
  processedEvents.add(eventId)

  // Cleanup old events to prevent memory leak
  if (processedEvents.size > MAX_PROCESSED_EVENTS) {
    const iterator = processedEvents.values()
    for (let i = 0; i < MAX_PROCESSED_EVENTS / 2; i++) {
      const value = iterator.next().value
      if (value) {
        processedEvents.delete(value)
      }
    }
  }

  return false
}

/**
 * Get or create session for Feishu chat
 */
function getOrCreateSession(chatId: string, spaceId: string, conversationId: string): FeishuSession {
  let session = feishuSessions.get(chatId)

  if (!session) {
    session = { spaceId, conversationId, chatId }
    feishuSessions.set(chatId, session)
  }

  return session
}

/**
 * Handle incoming message event from Feishu
 */
export async function handleMessageEvent(
  event: FeishuMessageEvent,
  spaceId: string,
  conversationId: string
): Promise<ControllerResponse> {
  try {
    const eventId = event.header.event_id

    // Deduplicate events
    if (isEventProcessed(eventId)) {
      console.log(`[Feishu] Skipping duplicate event: ${eventId}`)
      return { success: true, data: { skipped: true } }
    }

    const message = event.event.message
    const chatId = message.chat_id

    // Only handle text messages for now
    if (message.message_type !== 'text') {
      console.log(`[Feishu] Unsupported message type: ${message.message_type}`)
      return { success: true, data: { unsupported: true } }
    }

    // Parse message content
    let textContent: string
    try {
      const content = JSON.parse(message.content) as { text: string }
      textContent = content.text
    } catch {
      textContent = message.content
    }

    // Remove @bot mention if present
    textContent = textContent.replace(/@\S+\s*/g, '').trim()

    if (!textContent) {
      return { success: true, data: { empty: true } }
    }

    console.log(`[Feishu] Received message: ${textContent.substring(0, 50)}...`)

    // Get or create session for this chat
    let session = feishuSessions.get(chatId)

    if (!session) {
      // Check if conversation exists, if not create one
      let conversation = getConversation(spaceId, conversationId)

      if (!conversation) {
        console.log(`[Feishu] Creating new conversation for chat: ${chatId}`)
        conversation = createConversation(spaceId, `Feishu Chat ${chatId.substring(0, 8)}`)
      }

      session = {
        spaceId,
        conversationId: conversation.id,
        chatId
      }
      feishuSessions.set(chatId, session)
    }

    console.log(`[Feishu] Using conversation: ${session.conversationId}`)

    // Send message to Agent
    const mainWindow = getMainWindow()
    await agentSendMessage(mainWindow, {
      spaceId: session.spaceId,
      conversationId: session.conversationId,
      message: textContent
    })

    return { success: true }
  } catch (error) {
    console.error('[Feishu] Error handling message:', error)
    return { success: false, error: (error as Error).message }
  }
}

/**
 * Send Agent response back to Feishu
 */
export async function relayAgentResponse(
  chatId: string,
  response: string
): Promise<ControllerResponse> {
  // Truncate long responses
  const maxLength = 4000
  const truncated = response.length > maxLength
    ? response.substring(0, maxLength) + '\n\n[Message truncated...]'
    : response

  return sendFeishuMessage(chatId, truncated)
}

/**
 * Get session by conversation ID
 */
export function getSessionByConversation(conversationId: string): FeishuSession | undefined {
  const sessions = Array.from(feishuSessions.values())
  return sessions.find(session => session.conversationId === conversationId)
}

/**
 * Clear all sessions (for testing/reset)
 */
export function clearSessions(): void {
  feishuSessions.clear()
  processedEvents.clear()
}
