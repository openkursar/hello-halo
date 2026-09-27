import { useState } from 'react'
import { useAppsStore } from '../../stores/apps.store'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation } from '../../i18n'
import { CapabilityDialog } from './CapabilityDialog'
import { toSkillDirName } from '../../../shared/skill-naming'

export function ExistingSkillDialog({ spaceId, onClose, onAdded }: { spaceId: string | null; onClose: () => void; onAdded: () => void }) {
  const { t } = useTranslation()
  const apps = useAppsStore(state => state.apps)
  const installApp = useAppsStore(state => state.installApp)
  const spaces = useSpaceStore(state => state.spaces)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<string[]>([])
  const skills = apps.filter(app => app.spec.type === 'skill' && app.status !== 'uninstalled')
  return <CapabilityDialog title={t('Choose an existing skill')} onClose={() => { if (!busy) onClose() }}>
    <div className="space-y-4 p-4">
      <p className="text-sm text-muted-foreground">{t('Skills in this workspace and global skills are inherited automatically. Copying a skill from another workspace makes it available to everyone in the destination workspace; the original is unchanged.')}</p>
      <input value={query} onChange={event => setQuery(event.target.value)} aria-label={t('Search skills')} placeholder={t('Search skills')} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="space-y-2">{skills.filter(skill => `${skill.spec.display_name ?? skill.spec.name} ${skill.spec.description ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(skill => {
        const sameName = skills.find(other => other.spaceId === spaceId && toSkillDirName(other.specId) === toSkillDirName(skill.specId))
        const inScope = skill.spaceId === null || skill.spaceId === spaceId
        const scopeName = skill.spaceId === null ? t('Global') : [haloSpace, ...spaces].find(space => space?.id === skill.spaceId)?.name ?? t('Unavailable workspace')
        const copied = added.includes(skill.id)
        return <div key={skill.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div className="min-w-0"><p className="break-words text-sm font-medium">{skill.spec.display_name ?? skill.spec.name}</p><p className="text-xs text-muted-foreground">{scopeName}</p></div>
          {inScope ? <span className="text-xs text-muted-foreground">{sameName && sameName.status === 'active' && sameName.id !== skill.id ? t('Overridden in this workspace') : skill.status === 'paused' ? t('Disabled in shared settings') : t('Already available')}</span> : <button disabled={!!busy || !!sameName || copied} onClick={async () => {
            setBusy(skill.id); setError(null)
            try {
              const id = await installApp(spaceId, skill.spec)
              if (!id) throw new Error(t('Could not copy this skill. Please retry.'))
              setAdded(previous => [...previous, skill.id]); onAdded()
            } catch (err) { console.warn('[ExistingSkillDialog] Skill copy failed', { appId: skill.id, spaceId }); setError(err instanceof Error ? err.message : t('Could not copy this skill.')) } finally { setBusy(null) }
          }} className="text-sm text-primary disabled:text-muted-foreground">{copied ? t('Copied') : sameName ? t('Name already exists') : busy === skill.id ? t('Copying...') : t('Copy to this workspace')}</button>}
        </div>
      })}</div>
      {!skills.length && <p className="text-sm text-muted-foreground">{t('No installed skills yet.')}</p>}
      <button onClick={onClose} disabled={!!busy} className="rounded-lg border border-border px-3 py-2 text-sm">{t('Done')}</button>
    </div>
  </CapabilityDialog>
}
