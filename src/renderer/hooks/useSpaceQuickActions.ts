/**
 * useSpaceQuickActions — open the built-in browser or a space terminal as a
 * ContentCanvas tab. Shared by every surface that offers these two entries
 * (Header's more menu, the mobile overflow menu) so they open through the
 * exact same calls ArtifactRail used to make from its footer, instead of
 * each surface re-deriving its own gating logic.
 */

import { useCallback } from 'react'
import { useCanvasLifecycle } from './useCanvasLifecycle'
import { useUserTerminal } from './useUserTerminal'
import { getBrowserHomepage } from '../utils/browser-homepage'
import { api } from '../api'
import { useTranslation } from '../i18n'

const isWebMode = api.isRemoteMode()

interface SpaceQuickActions {
  /** Browser opens a local BrowserView — unavailable in Web mode. */
  canOpenBrowser: boolean
  openBrowser: () => void
  /** Terminal works over remote transport, so it survives Web mode. */
  terminalAvailable: boolean
  terminalCreating: boolean
  openTerminal: () => Promise<void>
}

export function useSpaceQuickActions(): SpaceQuickActions {
  const { t } = useTranslation()
  const { openUrl } = useCanvasLifecycle()
  const { available: terminalAvailable, creating: terminalCreating, createAndOpen: openTerminal } = useUserTerminal()

  const openBrowser = useCallback(() => {
    getBrowserHomepage().then(url => openUrl(url, t('Browser')))
  }, [openUrl, t])

  return {
    canOpenBrowser: !isWebMode,
    openBrowser,
    terminalAvailable,
    terminalCreating,
    openTerminal,
  }
}
