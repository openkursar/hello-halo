/**
 * AppLifecycleMenu
 *
 * Object-level actions for a digital human: restart, share, export, clear
 * memory, uninstall. These act on the app itself rather than on anything a
 * particular tab shows, so they live in the persistent header instead of the
 * Settings panel — that also makes them reachable from Overview and Activity,
 * which previously could not get at them at all.
 *
 * The two destructive actions keep their own inline confirm step; they are
 * deliberately not merged into one generic dialog, because "forget what you
 * learned" and "remove from this space" fail in different ways and deserve
 * their own wording.
 */

import { useState, useCallback } from 'react'
import { MoreHorizontal, RefreshCw, Share2, Trash2, Unplug, Loader2, AlertTriangle } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { ShareCurrentAppDialog } from '../store/ShareCurrentAppDialog'

type PendingConfirm = 'clear-memory' | 'uninstall' | null

interface AppLifecycleMenuProps {
  appId: string
  spaceId: string | null
}

export function AppLifecycleMenu({ appId, spaceId }: AppLifecycleMenuProps) {
  const { t } = useTranslation()
  const { uninstallApp, restartAppAgent } = useAppsStore()
  const selectApp = useAppsPageStore(s => s.selectApp)

  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<PendingConfirm>(null)
  const [busy, setBusy] = useState(false)
  const [showShareDialog, setShowShareDialog] = useState(false)
  const [restarting, setRestarting] = useState(false)

  // Closing resets the confirm step so reopening never lands mid-confirmation.
  const closeMenu = useCallback(() => {
    setOpen(false)
    setConfirming(null)
  }, [])

  const handleRestart = useCallback(async () => {
    setRestarting(true)
    try {
      await restartAppAgent(appId)
    } finally {
      setRestarting(false)
      closeMenu()
    }
  }, [appId, restartAppAgent, closeMenu])

  const handleClearMemory = useCallback(async () => {
    setBusy(true)
    try {
      const res = await api.appClearMemory(appId)
      if (!res.success) console.error('[AppLifecycleMenu] appClearMemory failed:', res.error)
    } catch (err) {
      console.error('[AppLifecycleMenu] appClearMemory error:', err)
    } finally {
      setBusy(false)
      closeMenu()
    }
  }, [appId, closeMenu])

  const handleUninstall = useCallback(async () => {
    setBusy(true)
    try {
      const ok = await uninstallApp(appId)
      closeMenu()
      // The header stays mounted with the pre-uninstall view (it was routed
      // to once, at selection time, and doesn't re-route itself when the
      // app's status changes later) — re-selecting now that the status has
      // actually flipped sends the user to the reinstall/delete screen.
      if (ok) selectApp(appId, 'automation', spaceId ?? undefined)
    } finally {
      setBusy(false)
    }
  }, [appId, spaceId, uninstallApp, selectApp, closeMenu])

  return (
    <>
      <Popover open={open} onOpenChange={next => (next ? setOpen(true) : closeMenu())}>
        <PopoverTrigger
          title={t('More actions')}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
        >
          <MoreHorizontal className="w-4 h-4" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 py-1">
          {confirming === null ? (
            <>
              <MenuItem
                icon={restarting ? Loader2 : RefreshCw}
                spinning={restarting}
                label={t('Restart agent')}
                description={t('Reloads prompt and configuration. Conversation history is kept.')}
                onClick={handleRestart}
                disabled={restarting}
              />
              <MenuItem
                icon={Share2}
                label={t('Share')}
                onClick={() => { setOpen(false); setShowShareDialog(true) }}
              />

              <div className="my-1 border-t border-border" />

              <MenuItem
                icon={Trash2}
                label={t('Clear Memory')}
                tone="warning"
                onClick={() => setConfirming('clear-memory')}
              />
              <MenuItem
                icon={Unplug}
                label={t('Uninstall')}
                tone="danger"
                onClick={() => setConfirming('uninstall')}
              />
            </>
          ) : (
            <ConfirmPanel
              kind={confirming}
              busy={busy}
              onCancel={() => setConfirming(null)}
              onConfirm={confirming === 'clear-memory' ? handleClearMemory : handleUninstall}
              t={t}
            />
          )}
        </PopoverContent>
      </Popover>

      {showShareDialog && (
        <ShareCurrentAppDialog appId={appId} onClose={() => setShowShareDialog(false)} />
      )}
    </>
  )
}

function MenuItem({ icon: Icon, label, description, onClick, disabled, tone, spinning }: {
  icon: typeof RefreshCw
  label: string
  description?: string
  onClick: () => void
  disabled?: boolean
  tone?: 'warning' | 'danger'
  spinning?: boolean
}) {
  const toneClass =
    tone === 'danger' ? 'text-halo-error'
    : tone === 'warning' ? 'text-halo-warning'
    : 'text-muted-foreground'

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-secondary/80 transition-colors disabled:opacity-60"
    >
      <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${toneClass} ${spinning ? 'animate-spin' : ''}`} />
      <span className="min-w-0">
        <span className={`block text-sm ${tone ? toneClass : 'text-foreground'}`}>{label}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </span>
    </button>
  )
}

function ConfirmPanel({ kind, busy, onCancel, onConfirm, t }: {
  kind: Exclude<PendingConfirm, null>
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
  t: (s: string, opts?: Record<string, unknown>) => string
}) {
  const isClear = kind === 'clear-memory'
  const tone = isClear ? 'text-halo-warning' : 'text-halo-error'

  return (
    <div className="p-3 space-y-2.5">
      <div className="flex items-start gap-2">
        <AlertTriangle className={`w-4 h-4 flex-shrink-0 mt-0.5 ${tone}`} />
        <p className="text-xs text-muted-foreground">
          {isClear
            ? t('This will permanently delete all memory files (memory.md and run history). The app will start fresh on its next run.')
            : t('Are you sure you want to uninstall this app? You can reinstall it later.')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onConfirm}
          disabled={busy}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors disabled:opacity-50 ${
            isClear
              ? 'text-halo-warning border-halo-warning/30 hover:border-halo-warning/60'
              : 'text-halo-error border-halo-error/30 hover:border-halo-error/60'
          }`}
        >
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {isClear ? t('Confirm Clear') : t('Confirm Uninstall')}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-lg transition-colors disabled:opacity-50"
        >
          {t('Cancel')}
        </button>
      </div>
    </div>
  )
}
