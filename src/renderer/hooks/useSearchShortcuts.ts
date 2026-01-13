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

interface UseSearchShortcutsOptions {
  enabled?: boolean
  onSearch?: (scope: SearchScope) => void
}

export function useSearchShortcuts({
  enabled = true,
  onSearch
}: UseSearchShortcutsOptions = {}) {
  useEffect(() => {
    if (!enabled || !onSearch) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = typeof navigator !== 'undefined' &&
        navigator.platform.toUpperCase().indexOf('MAC') >= 0

      const metaKey = isMac ? e.metaKey : e.ctrlKey

      // Cmd+K / Ctrl+K - Global search
      if (metaKey && e.key === 'k' && !e.shiftKey) {
        e.preventDefault()
        onSearch('global')
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
  }, [enabled, onSearch])
}
