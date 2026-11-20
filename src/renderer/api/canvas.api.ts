/**
 * canvasApi — Content Canvas slice of the unified api object.
 */
import { httpRequest, isElectron, onEvent } from './_shared'
import type { ApiResponse } from './_shared'
import type { CanvasShowReply, CanvasShowRequest } from '../../shared/types/canvas-show'

export const canvasApi = {
  /**
   * Serve an HTML file's directory under its own preview origin (desktop only;
   * remote clients have no local file and preview with srcdoc).
   */
  openHtmlPreview: async (filePath: string): Promise<ApiResponse<{ url: string; host: string }>> => {
    if (!isElectron()) return { success: false, error: 'Preview origin is only available in the desktop app' }
    return window.halo.openHtmlPreview(filePath)
  },

  closeHtmlPreview: async (host: string): Promise<void> => {
    if (isElectron()) await window.halo.closeHtmlPreview(host)
  },

  /** The AI asks to bring its page, a terminal or a file in front of the user. */
  onCanvasShowRequest: (callback: (request: CanvasShowRequest) => void) =>
    onEvent('canvas:show-request', callback as (data: unknown) => void),

  /** This client's answer to a show request: switched to it, or only kept its tab. */
  replyCanvasShow: async (reply: CanvasShowReply): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.replyCanvasShow(reply)
    return httpRequest('POST', '/api/canvas/show-reply', { ...reply })
  },
}
