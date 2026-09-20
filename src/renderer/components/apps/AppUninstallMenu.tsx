/**
 * AppUninstallMenu
 *
 * Icon-only "more actions" trigger holding a single danger action, matching
 * AutomationHeader's AppLifecycleMenu overflow-menu convention. Skill and MCP
 * only have one object-level action (Uninstall) — no restart/clear-memory
 * equivalent — so they get this smaller sibling instead of reusing
 * AppLifecycleMenu itself, which is automation-specific.
 */

import { useState, useCallback } from 'react'
import { MoreHorizontal, Unplug, Loader2, AlertTriangle } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'

interface AppUninstallMenuProps {
  appId: string
  appType: string
  spaceId: string | null
  /** Confirmation body text — callers phrase what's at stake for their type. */
  message: string
}

export function AppUninstallMenu({ appId, appType, spaceId, message }: AppUninstallMenuProps) {
  const { t } = useTranslation()
  const uninstallApp = useAppsStore(s => s.uninstallApp)
  const selectApp = useAppsPageStore(s => s.selectApp)

  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const closeMenu = useCallback(() => {
    setOpen(false)
    setConfirming(false)
  }, [])

  const handleUninstall = useCallback(async () => {
    setBusy(true)
    try {
      const ok = await uninstallApp(appId)
      closeMenu()
      // The detail view stays mounted on the pre-uninstall page (it was
      // routed to once, at selection time, and doesn't re-route itself when
      // the app's status changes later) — re-selecting now that the status
      // has actually flipped sends the user to the reinstall/delete screen.
      if (ok) selectApp(appId, appType, spaceId ?? undefined)
    } finally {
      setBusy(false)
    }
  }, [appId, appType, spaceId, uninstallApp, selectApp, closeMenu])

  return (
    <Popover open={open} onOpenChange={next => (next ? setOpen(true) : closeMenu())}>
      <PopoverTrigger
        title={t('More actions')}
        className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 py-1">
        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-secondary/80 transition-colors"
          >
            <Unplug className="w-4 h-4 flex-shrink-0 mt-0.5 text-halo-error" />
            <span className="text-sm text-halo-error">{t('Uninstall')}</span>
          </button>
        ) : (
          <div className="p-3 space-y-2.5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-halo-error" />
              <p className="text-xs text-muted-foreground">{message}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleUninstall}
                disabled={busy}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border text-halo-error border-halo-error/30 hover:border-halo-error/60 transition-colors disabled:opacity-50"
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t('Confirm Uninstall')}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-lg transition-colors disabled:opacity-50"
              >
                {t('Cancel')}
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
