import { useEffect, useId, useRef, useState } from 'react'
import type { AISourcesConfig } from '../../../shared/types/ai-sources'
import type { SubagentModelProfile, SubagentModelSettings, SubagentModelTarget } from '../../../shared/types/subagent-models'
import { MODEL_SELECTION_LIMITS, validSubagentModelText } from '../../../shared/subagent-models'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { inlineFormPrimary, inlineFormSecondary } from '../ui/inline-form-actions'
import { TargetPicker } from './TargetPicker'
import { profileName, profilePurpose, targetKey } from './model-presentation'

const fieldClass = 'w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'

export function ProfileEditor({ profile: currentProfile, config, onSaved, onCancel, onBusyChange }: {
  profile?: SubagentModelProfile
  config: AISourcesConfig
  onSaved: (settings: SubagentModelSettings) => void
  onCancel: () => void
  onBusyChange: (busy: boolean) => void
}) {
  const { t } = useTranslation()
  const profile = useRef(currentProfile).current
  const id = useId()
  const form = useRef<HTMLFormElement>(null)
  const initialName = profile?.kind === 'custom' ? profile.name : ''
  const [name, setName] = useState(initialName)
  const initialPurpose = profile ? profilePurpose(profile, t) : ''
  const [description, setDescription] = useState(initialPurpose)
  const [target, setTarget] = useState<SubagentModelTarget | undefined>(profile?.target)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [draftNotice, setDraftNotice] = useState<string | null>(null)
  const targetChanged = !!target && (!profile?.target || targetKey(target) !== targetKey(profile.target))
  const changed = name !== initialName || description !== initialPurpose || targetChanged

  useEffect(() => { form.current?.querySelector<HTMLElement>('input, textarea')?.focus({ preventScroll: true }) }, [])

  const save = async () => {
    if (busyRef.current) return
    if (!target) { setError(t('Choose an account and model or a group.')); return }
    if (profile && !changed) { onCancel(); return }
    if (profile?.kind !== 'builtin' && !name.trim()) { setError(t('Enter a name.')); return }
    // A tier's default purpose is shown translated; an untouched one keeps its stored text.
    const savedDescription = profile && description === initialPurpose ? profile.description : description
    if (!validSubagentModelText(name, MODEL_SELECTION_LIMITS.nameCodePoints) || !validSubagentModelText(savedDescription, MODEL_SELECTION_LIMITS.descriptionCodePoints)) {
      setError(t('The name or purpose is too long or contains unsupported characters.'))
      return
    }
    busyRef.current = true
    setBusy(true)
    onBusyChange(true)
    setError(null)
    try {
      const input = { description: savedDescription, target, ...(profile?.kind === 'builtin' ? {} : { name: name.trim() }) }
      const result = profile
        ? await api.updateSubagentModel({ ...input, id: profile.id, expectedRevision: profile.revision })
        : await api.createSubagentModel({ ...input, name: name.trim() })
      if (!result.success || !result.data) {
        console.warn(`[SubagentModels] Profile save refused code=${result.code ?? 'unknown'}; previous assignment retained`)
        setError(result.code === 'revision-conflict' || result.code === 'conflict'
          ? t('This assignment changed elsewhere. Your draft is safe. Cancel and reopen it to edit the latest version.')
          : result.code === 'name-duplicate' ? t('This name is already used by a tier or another assignment. Choose a different name.')
          : t('Could not save this assignment. Your changes are still here. Try again.'))
        return
      }
      onSaved(result.data)
    } catch {
      console.warn('[SubagentModels] Profile save failed; previous assignment retained')
      setError(t('Could not save this assignment. Your changes are still here. Try again.'))
    } finally {
      busyRef.current = false
      setBusy(false)
      onBusyChange(false)
    }
  }

  return (
    <form ref={form} aria-label={profile ? profileName(profile) : t('New custom assignment')}
      onSubmit={event => { event.preventDefault(); void save() }}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        event.preventDefault()
        if (busyRef.current) return
        if (changed) setDraftNotice(t('Your draft is still here. Use Cancel to discard it.'))
        else onCancel()
      }} className="mt-4 space-y-3">
      <fieldset disabled={busy} className="min-w-0 space-y-3 border-0 p-0" aria-busy={busy}>
        {profile?.kind !== 'builtin' && (
          <div className="space-y-1.5">
            <label htmlFor={`${id}-name`} className="text-sm font-medium">{t('Name')}</label>
            <input id={`${id}-name`} value={name} onChange={event => setName(event.target.value)} maxLength={MODEL_SELECTION_LIMITS.nameCodePoints} className={fieldClass} required />
          </div>
        )}
        <div className="space-y-1.5">
          <label htmlFor={`${id}-purpose`} className="text-sm font-medium">{t('Suitable tasks')}</label>
          <textarea id={`${id}-purpose`} value={description} onChange={event => setDescription(event.target.value)} maxLength={MODEL_SELECTION_LIMITS.descriptionCodePoints} rows={3} className={fieldClass} />
        </div>
        <div className="space-y-1.5">
          <h4 className="text-sm font-medium">{t('Account and model')}</h4>
          <p className="text-xs text-muted-foreground">{t('Subtask content is sent to the selected account’s provider. A load-balancing group may use another model in the group.')}</p>
          <TargetPicker config={config} value={target} onChange={setTarget} />
        </div>
        {draftNotice && !error && <p role="status" className="break-words text-sm text-muted-foreground">{draftNotice}</p>}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onCancel} className={inlineFormSecondary}>{t('Cancel')}</button>
          <button type="submit" className={inlineFormPrimary}>{busy ? t('Saving...') : profile ? t('Save') : t('Create')}</button>
        </div>
      </fieldset>
    </form>
  )
}
