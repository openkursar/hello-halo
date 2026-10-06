/**
 * useSpaceQuickActions — open the built-in browser, a space terminal or the
 * changes view as a ContentCanvas tab. Shared by every surface that offers
 * these entries (Header's more menu, the mobile overflow menu) so they open
 * through the exact same calls, instead of each surface re-deriving its own
 * gating logic.
 */

import { useCallback, useEffect } from 'react'
import { useCanvasActions } from './useCanvasLifecycle'
import { useUserTerminal } from './useUserTerminal'
import { getBrowserHomepage } from '../utils/browser-homepage'
import { api } from '../api'
import { useTranslation } from '../i18n'
import { useSpaceStore } from '../stores/space.store'

const isWebMode = api.isRemoteMode()

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC')

/** How the changes shortcut reads on this platform. */
export const CHANGES_SHORTCUT_LABEL = isMac ? '⌃⇧G' : 'Ctrl+Shift+G'

interface SpaceQuickActions {
  /** Browser opens a local browser page — unavailable in Web mode. */
  canOpenBrowser: boolean
  /** Resolves with the id of the tab the browser opened in. */
  openBrowser: () => Promise<string>
  /** Terminal works over remote transport, so it survives Web mode. */
  terminalAvailable: boolean
  terminalCreating: boolean
  /** Resolves with the id of the terminal's tab, null when nothing opened. */
  openTerminal: () => Promise<string | null>
  /** Git runs on the host, so the changes view works remotely too; needs a space. */
  canOpenChanges: boolean
  /** Resolves with the id of the changes tab, null without a space. */
  openChanges: () => Promise<string | null>
}

/** Opens the current space's changes view; one tab per space. */
function useOpenChanges(): (() => Promise<string | null>) {
  const spaceId = useSpaceStore((s) => s.currentSpace?.id ?? null)
  const { openChanges } = useCanvasActions()
  return useCallback(
    async () => (spaceId ? openChanges({ kind: 'git', spaceId }) : null),
    [spaceId, openChanges]
  )
}

export function useSpaceQuickActions(): SpaceQuickActions {
  const { t } = useTranslation()
  const { openUrl } = useCanvasActions()
  const { available: terminalAvailable, creating: terminalCreating, createAndOpen: openTerminal } = useUserTerminal()
  const hasSpace = useSpaceStore((s) => s.currentSpace != null)
  const openChanges = useOpenChanges()

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
    canOpenChanges: hasSpace,
    openChanges,
  }
}

/**
 * Ctrl+Shift+G opens the changes view, on every platform (also on macOS, where
 * ⌘⇧G stays "find previous", as code editors have it). A key an editor already
 * handled is left alone.
 */
export function useChangesShortcut(): void {
  const openChanges = useOpenChanges()

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return
      if (e.code !== 'KeyG') return
      e.preventDefault()
      void openChanges()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openChanges])
}
