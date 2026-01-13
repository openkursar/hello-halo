/**
 * Hook for window maximize state management
 *
 * Provides:
 * - Current maximize state
 * - Toggle function
 * - Listens for external maximize changes
 */

import { useState, useEffect, useCallback } from 'react'
import { api } from '../../../api'

export function useWindowMaximize() {
  const [isMaximized, setIsMaximized] = useState(false)

  // Check initial state and subscribe to changes
  useEffect(() => {
    // Get initial state
    api.isWindowMaximized().then((res) => {
      if (res.success && res.data !== undefined) {
        setIsMaximized(res.data)
      }
    })

    // Listen for changes from main process
    const cleanup = api.onWindowMaximizeChange((maximized) => {
      setIsMaximized(maximized)
    })

    return cleanup
  }, [])

  // Toggle maximize state
  const toggleMaximize = useCallback(async () => {
    await api.toggleMaximizeWindow()
  }, [])

  return {
    isMaximized,
    toggleMaximize
  }
}
