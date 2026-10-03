/**
 * useSpaceQuickActions — open the built-in browser or a space terminal as a
 * ContentCanvas tab. Shared by every surface that offers these two entries
 * (Header's more menu, the mobile overflow menu) so they open through the
 * exact same calls ArtifactRail used to make from its footer, instead of
 * each surface re-deriving its own gating logic.
 */

import { useCallback } from 'react'
import { useCanvasActions } from './useCanvasLifecycle'
import { useUserTerminal } from './useUserTerminal'
import { getBrowserHomepage } from '../utils/browser-homepage'
import { api } from '../api'
import { useTranslation } from '../i18n'

const isWebMode = api.isRemoteMode()

interface SpaceQuickActions {
  /** Browser opens a local BrowserView — unavailable in Web mode. */
  canOpenBrowser: boolean
  /** Resolves with the id of the tab the browser opened in. */
  openBrowser: () => Promise<string>
  /** Terminal works over remote transport, so it survives Web mode. */
  terminalAvailable: boolean
  terminalCreating: boolean
  /** Resolves with the id of the terminal's tab, null when nothing opened. */
  openTerminal: () => Promise<string | null>
}

export function useSpaceQuickActions(): SpaceQuickActions {
  const { t } = useTranslation()
  const { openUrl } = useCanvasActions()
  const { available: terminalAvailable, creating: terminalCreating, createAndOpen: openTerminal } = useUserTerminal()

  const openBrowser = useCallback(
    () => getBrowserHomepage().then(url => openUrl(url, t('Browser'))),
    [openUrl, t]
  )

  return {
    canOpenBrowser: !isWebMode,
    openBrowser,
    terminalAvailable,
    terminalCreating,
    openTerminal,
  }
}
