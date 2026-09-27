/**
 * WorkspaceMigrationDialog
 *
 * Changes which workspace a digital human starts new work in. Opened from the
 * person's action menus; settings carries no copy of it, so the menu entry is
 * the flow rather than a link to it.
 *
 * The move is previewed before it is applied: running work, pending decisions
 * and existing sessions all keep their original environment, so the preview is
 * the only place the user can see what actually shifts.
 */

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
  /** The workspace the digital human currently starts new work in. */
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
      if (!await moveAppToSpace(appId, preview.toSpaceId)) throw new Error(t('Could not change the workspace. Existing work is unchanged; retry after checking availability.'))
      // The dialog closes on success, so the confirmation has to outlive it.
      useNotificationStore.getState().show({
        title: t('Workspace updated'),
        body: t('Default workspace updated for new work. Existing work and files were retained.'),
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
    <CapabilityDialog title={t('Change default workspace')} onClose={() => { if (!busy) onClose() }}>
      <div className="space-y-4 p-4">
        <label className="block text-sm">{t('Workspace for new work')}
          <select disabled={busy} value={target} onChange={event => { setTarget(event.target.value); setPreview(null); setError(null) }} className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2">
            <option value="" disabled>{t('Choose a workspace')}</option>
            {choices.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
          </select>
        </label>
        <p className="text-sm text-muted-foreground">{t('New independent work starts here. Existing work keeps its original environment; team work keeps its team environment.')}</p>
        <p className="text-sm text-muted-foreground">{t('Files and history are not moved. Personal memory and existing work remain available. Changes to permissions still apply to continuing work.')}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {preview && <div className="space-y-3 rounded-lg border border-border p-3 text-sm">
          <p>{t('{{running}} active runs, {{pending}} decisions and {{sessions}} existing sessions keep their original environment.', { running: preview.activeRunCount, pending: preview.pendingDecisionCount, sessions: preview.retainedSessionCount })}</p>
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
            : <button disabled={busy} onClick={() => void apply()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}{t('Use for new work')}</button>}
        </div>
      </div>
    </CapabilityDialog>
  )
}
