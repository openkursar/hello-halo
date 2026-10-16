/**
 * Ask main to refresh out-of-date model lists while a model picker is open.
 * Main decides whether anything is fetched; a changed list arrives through
 * the catalog-changed event that App subscribes to.
 */

import { useEffect } from 'react'
import { api } from '../api'

export function useFreshModelCatalogs(open: boolean): void {
  useEffect(() => {
    if (!open) return
    api.refreshStaleModelCatalogs().catch(error => {
      console.warn('[useFreshModelCatalogs] Request failed:', error)
    })
  }, [open])
}
