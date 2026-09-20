import { useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation } from '../../i18n'
import type { InstalledApp } from '../../../shared/apps/app-types'
import type { AppSpaceChangePreview } from '../../../shared/apps/app-environment'
import { CapabilityDialog } from './CapabilityDialog'

export function DefaultWorkspaceSection({ app }: { app: InstalledApp }) {
  const { t } = useTranslation()
  const spaces = useSpaceStore(state => state.spaces)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const moveAppToSpace = useAppsStore(state => state.moveAppToSpace)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState(app.spaceId ?? '')
  const [preview, setPreview] = useState<AppSpaceChangePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const choices = [...(haloSpace ? [haloSpace] : []), ...spaces.filter(space => space.id !== haloSpace?.id)]
  const currentName = choices.find(space => space.id === app.spaceId)?.name ?? t('Unavailable workspace')
  const check = async () => {
    setBusy(true); setError(null)
    try {
      const response = await api.appPreviewSpaceChange(app.id, target)
      if (!response.success || !response.data) throw new Error(response.error || t('Could not preview this workspace change.'))
      setPreview(response.data)
    } catch (err) {
      console.warn('[DefaultWorkspaceSection] Workspace preview failed', { appId: app.id, target })
      setError(err instanceof Error ? err.message : t('Could not preview this workspace change.'))
    } finally { setBusy(false) }
  }
  return <section className="space-y-3 rounded-xl border border-border p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-medium"><FolderOpen className="h-4 w-4" />{t('Default workspace')}</h3><p className="mt-1 text-sm text-muted-foreground">{currentName}</p></div>
      <button onClick={() => { setTarget(app.spaceId ?? ''); setPreview(null); setError(null); setOpen(true) }} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary">{t('Change')}</button></div>
    <p className="text-xs text-muted-foreground">{t('New independent work starts here. Existing work keeps its original environment; team work keeps its team environment.')}</p>
    {saved && <p role="status" className="text-xs text-primary">{t('Default workspace updated for new work. Existing work and files were retained.')}</p>}
    {open && <CapabilityDialog title={t('Change default workspace')} onClose={() => { if (!busy) setOpen(false) }}>
      <div className="space-y-4 p-4">
        <label className="block text-sm">{t('Workspace for new work')}<select disabled={busy} value={target} onChange={event => { setTarget(event.target.value); setPreview(null); setError(null) }} className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2"><option value="" disabled>{t('Choose a workspace')}</option>{choices.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
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
        <div className="flex flex-wrap justify-end gap-2"><button disabled={busy} onClick={() => setOpen(false)} className="rounded-lg border border-border px-3 py-2 text-sm">{t('Cancel')}</button>
          {!preview ? <button disabled={busy || !target || target === app.spaceId} onClick={() => void check()} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy ? t('Checking...') : t('Preview change')}</button> : <button disabled={busy} onClick={async () => {
            setBusy(true); setError(null)
            try {
              if (!await moveAppToSpace(app.id, preview.toSpaceId)) throw new Error(t('Could not change the workspace. Existing work is unchanged; retry after checking availability.'))
              setSaved(true); setOpen(false)
            } catch (err) { console.warn('[DefaultWorkspaceSection] Workspace change failed', { appId: app.id }); setError(err instanceof Error ? err.message : t('Could not change the workspace.')) } finally { setBusy(false) }
          }} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}{t('Use for new work')}</button>}
        </div>
      </div>
    </CapabilityDialog>}
  </section>
}
