/**
 * WeChat iLink Bot IPC Handlers
 *
 * Provides IPC channels for the QR code login flow:
 *   weixin-ilink:request-qrcode  — fetch QR code from iLink API
 *   weixin-ilink:poll-auth-status — poll QR scan status (renderer calls repeatedly ~1s)
 *   weixin-ilink:save-token      — persist bot_token + accountId + baseUrl into instance config
 *   weixin-ilink:disconnect      — clear credentials from instance config
 *
 * Protocol notes (confirmed):
 *   get_bot_qrcode response has NO `ret` field — just { qrcode, qrcode_img_content }
 *     where qrcode_img_content is a URL (not base64).
 *   get_qrcode_status response has NO `ret` field — just { status, bot_token?,
 *     ilink_bot_id?, baseurl?, ilink_user_id? }. ilink_bot_id is required on 'confirmed'.
 *
 * Business logic (save-token / disconnect) lives in controllers/weixin-ilink.controller.ts
 * and is shared with the HTTP routes layer.
 *
 * These channels are desktop-only (Electron). Remote/web clients fall back to
 * HTTP stubs but cannot complete QR login.
 *
 * Registered from the typed RPC contract (passthrough — handler bodies and
 * return shapes preserved verbatim). Brand-specific auth flow (ARCHITECTURE §22.3).
 */

import { ILINK_BASE_URL, fetchJson } from '../apps/runtime/im-channels/ilink-api'
import { saveIlinkToken, disconnectIlink } from '../controllers/weixin-ilink.controller'
import { weixinIlinkRpc } from '../../shared/rpc/contracts/weixin-ilink.contract'
import { registerRawRpcHandlers } from './rpc'

// ============================================
// IPC Handler Registration
// ============================================

export function registerWeixinIlinkHandlers(): void {
  registerRawRpcHandlers(weixinIlinkRpc, {
    /**
     * Request a new QR code from iLink API.
     *
     * Response shape (no `ret` field):
     *   { qrcode: string, qrcode_img_content: string (URL) }
     *
     * Returns to renderer: { qrcode, qrcodeImgUrl, baseUrl }
     */
    weixinIlinkRequestQrcode: async () => {
      try {
        // GET requests do NOT use auth headers (per iLink protocol)
        const url = `${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`

        // No `ret` field in this response
        interface QrCodeResponse {
          qrcode?: string
          qrcode_img_content?: string   // URL to QR code image
        }

        const response = await fetchJson<QrCodeResponse>('GET', url, {})

        if (!response.qrcode) {
          return { success: false, error: 'iLink API returned no qrcode token' }
        }

        return {
          success: true,
          data: {
            qrcode: response.qrcode,
            qrcodeImgContent: response.qrcode_img_content ?? '',
            baseUrl: ILINK_BASE_URL,
          },
        }
      } catch (error: unknown) {
        console.error('[WeixinIlink] request-qrcode error:', error)
        return { success: false, error: (error as Error).message }
      }
    },

    /**
     * Poll QR code scan status.
     * Renderer calls this every ~1s until status is 'confirmed' or 'expired'.
     *
     * Returns to renderer: { status, botToken?, accountId?, baseUrl?, userId? }
     */
    weixinIlinkPollAuthStatus: async (qrcode: string) => {
      try {
        if (!qrcode) {
          return { success: false, error: 'qrcode parameter is required' }
        }

        // get_qrcode_status requires iLink-App-ClientVersion header (per protocol)
        const url = `${ILINK_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`

        // No `ret` field in this response
        interface QrStatusResponse {
          status?: 'wait' | 'scaned' | 'confirmed' | 'expired'
          bot_token?: string
          ilink_bot_id?: string    // becomes accountId — required on confirmed
          baseurl?: string
          ilink_user_id?: string   // who scanned
        }

        const response = await fetchJson<QrStatusResponse>('GET', url, { 'iLink-App-ClientVersion': '1' })

        // Validate confirmed response has required fields
        if (response.status === 'confirmed' && !response.ilink_bot_id) {
          console.error('[WeixinIlink] poll-auth-status: confirmed but ilink_bot_id missing')
          return { success: false, error: 'iLink confirmed login but ilink_bot_id is missing' }
        }

        return {
          success: true,
          data: {
            status: response.status ?? 'wait',
            botToken: response.bot_token,
            accountId: response.ilink_bot_id,
            baseUrl: response.baseurl,
            userId: response.ilink_user_id,
          },
        }
      } catch (error: unknown) {
        console.error('[WeixinIlink] poll-auth-status error:', error)
        return { success: false, error: (error as Error).message }
      }
    },

    /**
     * Save credentials into the instance config after confirmed QR scan.
     * Persists bot_token, accountId (ilink_bot_id), and baseUrl.
     * Triggers manager reload to start the long-poll connection.
     */
    weixinIlinkSaveToken: async (instanceId: string, botToken: string, baseUrl?: string, accountId?: string) => {
      try {
        return await saveIlinkToken(instanceId, botToken, baseUrl, accountId)
      } catch (error: unknown) {
        console.error('[WeixinIlink] save-token error:', error)
        return { success: false, error: (error as Error).message }
      }
    },

    /**
     * Disconnect: clear all credentials from instance config and stop polling.
     */
    weixinIlinkDisconnect: async (instanceId: string) => {
      try {
        return await disconnectIlink(instanceId)
      } catch (error: unknown) {
        console.error('[WeixinIlink] disconnect error:', error)
        return { success: false, error: (error as Error).message }
      }
    },
  })

  console.log('[WeixinIlink] IPC handlers registered')
}
