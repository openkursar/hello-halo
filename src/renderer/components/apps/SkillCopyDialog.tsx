import { useRef, useState } from 'react'
import { api } from '../../api'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation } from '../../i18n'
import type { SkillRef } from '../../../shared/types/skills'
import { CapabilityDialog } from './CapabilityDialog'

export function SkillCopyDialog({ skillRef, name: originalName, content, spaceId, onClose, onSaved }: {
  skillRef: SkillRef; name: string; content?: string; spaceId: string | null; onClose: () => void; onSaved: () => void
}) {
  const { t } = useTranslation()
  const spaces = useSpaceStore(state => state.spaces)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const [name, setName] = useState(`${originalName}-custom`)
  const [target, setTarget] = useState(spaceId ?? '')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const allSpaces = [...(haloSpace ? [haloSpace] : []), ...spaces.filter(space => space.id !== haloSpace?.id)]
  return <CapabilityDialog title={t('Save a custom skill copy')} onClose={() => { if (!submitting.current) onClose() }}>
    <div className="space-y-4 p-4">
      <p className="text-sm text-muted-foreground">{t('The original stays unchanged. All supporting files are copied. The copies are independent and changes will not sync.')}</p>
      <label className="block text-sm">{t('Command name')}<input value={name} onChange={event => setName(event.target.value)} className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2" /></label>
      <label className="block text-sm">{t('Destination')}<select value={target} onChange={event => setTarget(event.target.value)} className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2"><option value="">{t('Global (all spaces)')}</option>{allSpaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><button disabled={busy} onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-sm">{t('Cancel')}</button><button disabled={busy || !name.trim()} onClick={async () => {
        if (submitting.current) return
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.trim())) { setError(t('Use lowercase letters, numbers and hyphens for the command name.')); return }
        submitting.current = true
        setBusy(true); setError(null)
        try {
          const result = await api.skillsCopy({ ref: skillRef, spaceId: target || null, name: name.trim(), content })
          if (!result.success) throw new Error(result.error || t('Could not save the custom copy.'))
          onSaved(); onClose()
        } catch (err) {
          console.warn('[SkillCopyDialog] Skill copy failed', { id: skillRef.id })
          setError(err instanceof Error ? err.message : t('Could not save the custom copy.'))
        } finally { submitting.current = false; setBusy(false) }
      }} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy ? t('Saving...') : t('Save custom copy')}</button></div>
    </div>
  </CapabilityDialog>
}
