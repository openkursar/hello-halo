/**
 * useSearchShortcuts Hook
 *
 * Manages keyboard shortcuts for search:
 * - Cmd+K / Ctrl+K: Global search
 * - Cmd+F / Ctrl+F: Conversation search (or space search if on space page)
 * - Cmd+Shift+F / Ctrl+Shift+F: Space search
 */

import { useEffect } from 'react'
import { SearchScope } from '@/components/search'
import { useSearchStore } from '@/stores/search.store'

interface UseSearchShortcutsOptions {
  enabled?: boolean
  onSearch?: (scope: SearchScope) => void
}

export function useSearchShortcuts({
  enabled = true,
  onSearch
}: UseSearchShortcutsOptions = {}) {
  // ⌘K specifically toggles (prototype: `open ? closeCmdk() : openCmdk()`),
  // rather than always re-opening — otherwise pressing it while the panel
  // is already open (e.g. to close it) would instead reset searchScope
  // back to 'global', discarding whatever scope the user had picked.
  const isSearchOpen = useSearchStore(state => state.isSearchOpen)
  const closeSearch = useSearchStore(state => state.closeSearch)

  useEffect(() => {
    if (!enabled || !onSearch) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if the event was already handled by a focused component
      // (e.g. CodeMirror's in-editor search)
      if (e.defaultPrevented) return

      const isMac = typeof navigator !== 'undefined' &&
        navigator.platform.toUpperCase().indexOf('MAC') >= 0

      const metaKey = isMac ? e.metaKey : e.ctrlKey

      // Cmd+K / Ctrl+K - toggle global search
      if (metaKey && e.key === 'k' && !e.shiftKey) {
        e.preventDefault()
        if (isSearchOpen) closeSearch()
        else onSearch('global')
        return
      }

      // Cmd+Shift+F / Ctrl+Shift+F - Space search
      if (metaKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault()
        onSearch('space')
        return
      }

      // Cmd+F / Ctrl+F - Conversation search
      // Note: This may conflict with browser Find dialog in web mode,
      // which is why we recommend Cmd+K for global as the primary shortcut
      if (metaKey && (e.key === 'f' || e.key === 'F') && !e.shiftKey) {
        // Only handle in Electron mode to avoid browser Find conflict
        if (typeof window !== 'undefined' && 'halo' in window) {
          e.preventDefault()
          onSearch('conversation')
        }
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, onSearch, isSearchOpen, closeSearch])
}
