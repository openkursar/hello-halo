/** Moves a digital human with its memory and conversations after previewing the impact. */

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import { useSpaceStore } from '../../stores/space.store'
import { useNotificationStore } from '../../stores/notification.store'
import { useTranslation } from '../../i18n'
import type { AppSpaceChangePreview } from '../../../shared/apps/app-environment'
import { CapabilityDialog } from './CapabilityDialog'

interface WorkspaceMigrationDialogProps {
  appId: string
  /** The workspace the digital human currently belongs to. */
  spaceId: string | null
  onClose: () => void
}

export function WorkspaceMigrationDialog({ appId, spaceId, onClose }: WorkspaceMigrationDialogProps) {
  const { t } = useTranslation()
  const spaces = useSpaceStore(state => state.spaces)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const moveAppToSpace = useAppsStore(state => state.moveAppToSpace)
  const [target, setTarget] = useState(spaceId ?? '')
  const [preview, setPreview] = useState<AppSpaceChangePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choices = [...(haloSpace ? [haloSpace] : []), ...spaces.filter(space => space.id !== haloSpace?.id)]

  const check = async () => {
    setBusy(true); setError(null)
    try {
      const response = await api.appPreviewSpaceChange(appId, target)
      if (!response.success || !response.data) throw new Error(response.error || t('Could not preview this workspace change.'))
      setPreview(response.data)
    } catch (err) {
      console.warn('[WorkspaceMigrationDialog] Workspace preview failed', { appId, target })
      setError(err instanceof Error ? err.message : t('Could not preview this workspace change.'))
    } finally { setBusy(false) }
  }

  const apply = async () => {
    if (!preview) return
    setBusy(true); setError(null)
    try {
      if (!await moveAppToSpace(appId, preview.toSpaceId)) throw new Error(t('Could not move to this workspace. Running work may have stopped. Check availability and try again.'))
      // The dialog closes on success, so the confirmation has to outlive it.
      useNotificationStore.getState().show({
        title: t('Workspace updated'),
        body: t('Memory and all conversations moved to the new workspace. Project files stayed where they were.'),
        variant: 'success',
        duration: 4000,
      })
      onClose()
    } catch (err) {
      console.warn('[WorkspaceMigrationDialog] Workspace change failed', { appId })
      setError(err instanceof Error ? err.message : t('Could not change the workspace.'))
    } finally { setBusy(false) }
  }

  return (
    <CapabilityDialog title={t('Change workspace')} onClose={() => { if (!busy) onClose() }}>
      <div className="space-y-4 break-words p-4">
        <label className="block text-sm">{t('Workspace')}
          <select disabled={busy} value={target} onChange={event => { setTarget(event.target.value); setPreview(null); setError(null) }} className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2">
            <option value="" disabled>{t('Choose a workspace')}</option>
            {choices.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
          </select>
        </label>
        <p className="text-sm text-muted-foreground">{t('Memory and all conversations move to the new workspace together. Files in the project folder stay where they are.')}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {preview && <div className="space-y-3 rounded-lg border border-border p-3 text-sm">
          {preview.activeRunCount + preview.activeChatCount > 0 && <p className="text-halo-warning">{t('Ongoing work that will stop when you confirm: {{count}}.', { count: preview.activeRunCount + preview.activeChatCount })}</p>}
          <p>{t('Pending decisions to keep: {{pending}}. Conversations to move: {{sessions}}.', { pending: preview.pendingDecisionCount, sessions: preview.retainedSessionCount })}</p>
          {[
            { label: t('Skills added'), values: preview.addedSkills },
            { label: t('Skills no longer inherited'), values: preview.removedSkills },
            { label: t('Independent task connections added'), values: preview.addedConnections },
            { label: t('Independent task connections no longer available'), values: preview.removedConnections },
            { label: t('New chat connections added'), values: preview.addedChatConnections ?? [] },
            { label: t('New chat connections no longer inherited'), values: preview.removedChatConnections ?? [] },
          ].map(group => <div key={group.label}><p className="font-medium">{group.label}</p><p className="break-words text-xs text-muted-foreground">{group.values.length ? group.values.join(', ') : t('None')}</p></div>)}
          {preview.warnings.map(warning => <p key={warning} className="text-xs text-destructive">{t(warning)}</p>)}
        </div>}
        <div className="flex flex-wrap justify-end gap-2">
          <button disabled={busy} onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-sm">{t('Cancel')}</button>
          {!preview
            ? <button disabled={busy || !target || target === spaceId} onClick={() => void check()} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy ? t('Checking...') : t('Preview change')}</button>
            : <button disabled={busy} onClick={() => void apply()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}{t('Move here')}</button>}
        </div>
      </div>
    </CapabilityDialog>
  )
}
