import { useState } from 'react'
import { useAppsStore } from '../../stores/apps.store'
import { useTranslation } from '../../i18n'
import { buildSkillContentPatch } from '../../utils/skill-content'
import type { SkillSpec } from '../../../shared/apps/spec-types'
import { CapabilityDialog } from './CapabilityDialog'

export function SkillCopyDialog({ spec, content, spaceId, onClose, onSaved }: {
  spec: SkillSpec; content: string; spaceId: string | null; onClose: () => void; onSaved: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(`${spec.name}-custom`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return <CapabilityDialog title={t('Save a custom skill copy')} onClose={() => { if (!busy) onClose() }}>
    <div className="space-y-4 p-4">
      <p className="text-sm text-muted-foreground">{t('The original stays unchanged. This copy uses a new command name and will not receive updates from the original store listing. It is available to everyone in the same scope.')}</p>
      <label className="block text-sm">{t('Command name')}<input value={name} onChange={event => setName(event.target.value)} className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2" /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2"><button disabled={busy} onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-sm">{t('Cancel')}</button><button disabled={busy || !name.trim()} onClick={async () => {
        const state = useAppsStore.getState()
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.trim())) { setError(t('Use lowercase letters, numbers and hyphens for the command name.')); return }
        if (state.apps.some(app => app.spaceId === spaceId && app.status !== 'uninstalled' && app.specId === name.trim())) { setError(t('This command name already exists. Choose another name.')); return }
        setBusy(true); setError(null)
        try {
          const copy = { ...spec, ...buildSkillContentPatch(spec, content), name: name.trim(), display_name: name.trim(), store: { install_source: 'manual' as const } }
          const id = await state.installApp(spaceId, copy)
          if (!id) throw new Error(t('Could not save the custom copy.'))
          onSaved(); onClose()
        } catch (err) { console.warn('[SkillCopyDialog] Could not create custom copy'); setError(err instanceof Error ? err.message : t('Could not save the custom copy.')) } finally { setBusy(false) }
      }} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy ? t('Saving...') : t('Save custom copy')}</button></div>
    </div>
  </CapabilityDialog>
}
