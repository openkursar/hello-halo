/**
 * canvasApi — Content Canvas slice of the unified api object.
 */
import { isElectron } from './_shared'
import type { ApiResponse } from './_shared'

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
}
