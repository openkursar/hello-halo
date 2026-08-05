/**
 * Update Notification Listener
 *
 * Surfaces exactly one toast, and only once the update has stopped needing the
 * user's patience: either it is staged and ready to apply, or it failed and the
 * download page is the way out. Checking and downloading stay silent — the user
 * cannot pause, cancel or speed up a background download, so a progress toast
 * would occupy a corner of the screen for minutes while offering no action.
 *
 * 'manual-download' is the degraded path: the main process emits it when an
 * announced update could not be downloaded or staged, so the user is handed the
 * download page instead of a progress bar that never finishes.
 *
 * The prompt is sticky — the user either applies the update or defers it for the
 * day. Deferral is remembered per version so the hourly re-check does not
 * re-open a prompt the user already answered.
 */

import { useEffect, useRef } from 'react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { useNotificationStore } from '../../stores/notification.store'

// Stable toast ID so lifecycle events replace rather than duplicate
const UPDATE_TOAST_ID = 'updater-lifecycle'

const SNOOZE_STORAGE_KEY = 'halo-update-snooze'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function isSnoozed(version: string): boolean {
  try {
    return localStorage.getItem(SNOOZE_STORAGE_KEY) === `${version}|${today()}`
  } catch {
    return false
  }
}

function snooze(version: string): void {
  try {
    localStorage.setItem(SNOOZE_STORAGE_KEY, `${version}|${today()}`)
  } catch {
    /* private mode or quota — deferral just does not persist */
  }
}

/**
 * Normalize release notes into a markdown list.
 *
 * The feed carries either a plain string (one change per line, bulleted or not)
 * or electron-updater's per-version array. Re-bulleting every line makes the
 * two shapes render identically instead of depending on how the release was
 * authored. Tags are stripped because the GitHub provider falls back to the raw
 * release body, which can carry markup the restricted renderer would drop
 * mid-sentence.
 */
function formatReleaseNotes(notes: string | { version: string; note: string }[] | undefined): string {
  if (!notes) return ''

  const lines = typeof notes === 'string'
    ? notes.split('\n')
    : Array.isArray(notes)
      ? notes.map(item => item.note)
      : []

  return lines
    .map(line => line.replace(/<[^>]*>/g, '').trim())
    .filter(line => line.length > 0)
    .map(line => `- ${line.replace(/^[-*+]\s*/, '')}`)
    .join('\n')
}

export function UpdateNotification() {
  const { t } = useTranslation()
  const show = useNotificationStore((s) => s.show)

  // Keeps the latest values available to the action callbacks without
  // resubscribing the IPC listener on every event.
  const stateRef = useRef({ downloadUrl: '' })

  useEffect(() => {
    const unsubscribe = api.onUpdaterStatus((data) => {
      const version = data.version
      if (!version || isSnoozed(version)) return

      const title = t('New version Halo {{version}} available', { version })
      const deferAction = {
        label: t("Don't remind me today"),
        onClick: () => snooze(version),
      }
      const notes = formatReleaseNotes(data.releaseNotes)

      if (data.status === 'downloaded') {
        const isInstaller = data.installMode === 'installer'
        show({
          id: UPDATE_TOAST_ID,
          title,
          body: notes || (isInstaller
            ? t('Halo will close and the installer will guide you through it')
            : t('Applies in a few seconds, then Halo reopens')),
          bodyFormat: notes ? 'markdown' : 'text',
          variant: 'success',
          duration: 0,
          action: {
            label: isInstaller ? t('Install now') : t('Restart now'),
            onClick: () => { api.installUpdate() },
          },
          secondaryAction: deferAction,
        })
        return
      }

      if (data.status === 'manual-download') {
        stateRef.current.downloadUrl = data.downloadUrl ?? ''
        show({
          id: UPDATE_TOAST_ID,
          title,
          body: t('Could not update automatically — you can download this version manually'),
          variant: 'warning',
          duration: 0,
          action: {
            label: t('Go to download'),
            onClick: () => {
              const { downloadUrl } = stateRef.current
              if (downloadUrl) window.open(downloadUrl, '_blank')
            },
          },
          secondaryAction: deferAction,
        })
      }
    })

    return () => { unsubscribe() }
  }, [show, t])

  // Rendering is handled by the global NotificationToast
  return null
}
