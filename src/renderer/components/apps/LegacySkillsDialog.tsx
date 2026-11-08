import { useRef, useState } from 'react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { useSpaceStore } from '../../stores/space.store'
import { CapabilityDialog } from './CapabilityDialog'
import type { LegacySkill } from '../../../shared/types/skills'

export function LegacySkillsDialog({ skills, onClose, onChanged }: { skills: LegacySkill[]; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation()
  const spaces = useSpaceStore(state => state.spaces)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const [target, setTarget] = useState(skills[0]?.spaceId ?? '')
  const [remaining, setRemaining] = useState(skills)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const allSpaces = [...(haloSpace ? [haloSpace] : []), ...spaces.filter(space => space.id !== haloSpace?.id)]
  async function apply(skill: LegacySkill, remove: boolean) {
    if (running.current) return
    running.current = true; setBusy(true); setError(null)
    try {
      if (remove && !await showConfirm({ title: t('Delete legacy skill content?'), message: t('This removes the saved content from the old installation. It does not delete other skill copies.'), confirmLabel: t('Delete'), cancelLabel: t('Cancel'), variant: 'danger' })) return
      const result = remove ? await api.skillsDeleteLegacy({ appId: skill.appId }) : await api.skillsRestoreLegacy({ appId: skill.appId, spaceId: target || null })
      if (!result.success) throw new Error(result.error || t('Could not process this legacy skill.'))
      setRemaining(items => items.filter(item => item.appId !== skill.appId)); onChanged()
    } catch (err) { console.warn('[LegacySkillsDialog] Legacy recovery failed', { appId: skill.appId }); setError(err instanceof Error ? err.message : t('Could not process this legacy skill.')) } finally { running.current = false; setBusy(false) }
  }
  return <CapabilityDialog title={t('Recover legacy skill content')} onClose={() => { if (!running.current) onClose() }}><div className="space-y-4 p-4"><p className="text-sm text-muted-foreground">{t('These skills were removed in an older version. They have not been enabled automatically. Save their content as your own files or explicitly delete the old content.')}</p><label className="block text-sm">{t('Save to')}<select value={target} disabled={busy} onChange={event => setTarget(event.target.value)} className="mt-2 w-full rounded-lg border border-border bg-background p-2"><option value="">{t('Global (all spaces)')}</option>{allSpaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>{error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}{remaining.map(skill => <div key={skill.appId} className="space-y-2 rounded-lg border border-border p-3"><p className="break-words font-medium">{skill.name}</p><p className="break-words text-sm text-muted-foreground">{skill.description}</p><div className="flex flex-wrap gap-3"><button disabled={busy} onClick={() => void apply(skill, false)} className="text-sm text-primary">{t('Save as my skill')}</button><button disabled={busy} onClick={() => void apply(skill, true)} className="text-sm text-destructive">{t('Delete')}</button></div></div>)}{remaining.length === 0 && <p className="text-sm">{t('No legacy content remains.')}</p>}</div>{DialogComponent}</CapabilityDialog>
}
