import { useRef, useState } from 'react'
import { api } from '../../api'
import { useSpaceStore } from '../../stores/space.store'
import { useSkillInventory } from '../../hooks/useSkillInventory'
import { useTranslation } from '../../i18n'
import { CapabilityDialog } from './CapabilityDialog'

export function ExistingSkillDialog({ spaceId, onClose, onAdded }: { spaceId: string | null; onClose: () => void; onAdded: () => void }) {
  const { t } = useTranslation()
  const spaces = useSpaceStore(state => state.spaces)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const [source, setSource] = useState(spaceId ?? '')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const submitting = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<string[]>([])
  const inventory = useSkillInventory({ spaceId: source || null, q: query, offset, limit: 50 })
  const allSpaces = [...(haloSpace ? [haloSpace] : []), ...spaces.filter(space => space.id !== haloSpace?.id)]
  return <CapabilityDialog title={t('Choose an existing skill')} onClose={() => { if (!submitting.current) onClose() }}>
    <div className="space-y-4 p-4">
      <p className="text-sm text-muted-foreground">{t('Choose a skill from another workspace to copy here. The original will stay unchanged.')}</p>
      <label className="block text-sm">{t('Source workspace')}<select value={source} disabled={!!busy} onChange={event => { setSource(event.target.value); setOffset(0) }} className="mt-2 w-full rounded-lg border border-border bg-background p-2"><option value="">{t('Global (all spaces)')}</option>{allSpaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
      <input value={query} onChange={event => { setQuery(event.target.value); setOffset(0) }} aria-label={t('Search skills')} placeholder={t('Search skills')} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
      {(error || inventory.error) && <p role="alert" className="break-words text-sm text-destructive">{error || inventory.error}</p>}
      {inventory.loading && <p role="status" className="text-sm text-muted-foreground">{t('Loading…')}</p>}
      <div className="space-y-2">{inventory.data?.groups.flatMap(group => group.copies).map(copy => {
        const inScope = copy.spaceId === null || copy.spaceId === spaceId
        const copied = added.includes(copy.id)
        return <div key={copy.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{copy.displayName}</p><p className="line-clamp-2 text-xs text-muted-foreground">{copy.description}</p></div>
          {inScope ? <span className="text-xs text-muted-foreground">{copy.enabled ? t('Already in this scope') : t('Disabled in shared settings')}</span> : <button disabled={!!busy || copied || copy.availability === 'missing' || copy.availability === 'invalid'} onClick={async () => {
            if (submitting.current) return
            submitting.current = true; setBusy(copy.id); setError(null)
            try {
              const result = await api.skillsCopy({ ref: { spaceId: source || null, id: copy.id }, spaceId, name: copy.name })
              if (!result.success) throw new Error(result.error || t('Could not copy this skill. Please retry.'))
              setAdded(previous => [...previous, copy.id]); onAdded()
            } catch (err) { console.warn('[ExistingSkillDialog] Skill copy failed', { id: copy.id }); setError(err instanceof Error ? err.message : t('Could not copy this skill.')) } finally { submitting.current = false; setBusy(null) }
          }} className="text-sm text-primary disabled:text-muted-foreground">{copied ? t('Copied') : busy === copy.id ? t('Copying...') : t('Copy to this workspace')}</button>}
        </div>
      })}</div>
      {!inventory.loading && inventory.data?.groups.length === 0 && <p className="text-sm text-muted-foreground">{t('No matching skills.')}</p>}
      <div className="flex flex-wrap gap-3"><button disabled={offset === 0 || inventory.loading} onClick={() => setOffset(value => Math.max(0, value - 50))} className="text-sm text-primary disabled:opacity-50">{t('Previous')}</button><button disabled={!inventory.data || offset + inventory.data.groups.length >= inventory.data.total || inventory.loading} onClick={() => setOffset(value => value + 50)} className="text-sm text-primary disabled:opacity-50">{t('Next')}</button></div>
      <button onClick={onClose} disabled={!!busy} className="rounded-lg border border-border px-3 py-2 text-sm">{t('Done')}</button>
    </div>
  </CapabilityDialog>
}
