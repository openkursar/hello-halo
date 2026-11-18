import { useEffect, useId, useRef, useState } from 'react'
import type { AISourcesConfig } from '../../../shared/types/ai-sources'
import type { SubagentModelProfile, SubagentModelTarget } from '../../../shared/types/subagent-models'
import { getSubagentModelTargetEfforts, MODEL_SELECTION_LIMITS, validSubagentModelText } from '../../../shared/subagent-models'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { Disclosure } from '../ui/Disclosure'
import { TargetPicker } from './TargetPicker'
import { defaultPurpose, profileName } from './model-presentation'
import type { SubagentModelSettings } from '../../../shared/types/subagent-models'

const fieldClass = 'w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'

export function ProfileEditor({ profile, config, onSaved, onCancel, onBusyChange }: {
  profile?: SubagentModelProfile
  config: AISourcesConfig
  onSaved: (settings: SubagentModelSettings) => void
  onCancel: () => void
  onBusyChange: (busy: boolean) => void
}) {
  const { t } = useTranslation()
  const originalProfile = useRef(profile).current
  profile = originalProfile
  const id = useId()
  const form = useRef<HTMLFormElement>(null)
  const [name, setName] = useState(profile?.kind === 'custom' ? profile.name : '')
  const [description, setDescription] = useState(profile?.description || (profile?.kind === 'builtin' ? defaultPurpose(profile.slot, t) : ''))
  const [target, setTarget] = useState<SubagentModelTarget | undefined>(profile?.target)
  const [effort, setEffort] = useState(profile?.reasoningEffort ?? '')
  const supportedEfforts = target ? getSubagentModelTargetEfforts(target, config) : []
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [draftNotice, setDraftNotice] = useState<string | null>(null)
  useEffect(() => { form.current?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true }) }, [])
  const save = async () => {
    if (busyRef.current) return
    if (!target) { setError(t('Choose an account and model or a group.')); return }
    if (profile?.kind !== 'builtin' && !name.trim()) { setError(t('Enter a name.')); return }
    if (!validSubagentModelText(name, MODEL_SELECTION_LIMITS.nameCodePoints) || !validSubagentModelText(description, MODEL_SELECTION_LIMITS.descriptionCodePoints)) { setError(t('The name or purpose is too long or contains unsupported characters.')); return }
    if (effort && !supportedEfforts.includes(effort)) { setError(t('Choose a reasoning effort supported by the selected target.')); return }
    busyRef.current = true
    setBusy(true)
    onBusyChange(true)
    setError(null)
    try {
      const input = { description, target, reasoningEffort: effort || undefined, ...(profile?.kind === 'builtin' ? {} : { name: name.trim() }) }
      const result = profile
        ? await api.updateSubagentModel({ ...input, id: profile.id, expectedRevision: profile.revision })
        : await api.createSubagentModel({ ...input, name: name.trim() })
      if (!result.success || !result.data) {
        console.warn(`[SubagentModels] Profile save refused code=${result.code ?? 'unknown'}; draft retained`)
        setError(result.code === 'revision-conflict' || result.code === 'conflict' ? t('This assignment changed elsewhere. Your draft is safe. Cancel and reopen it to edit the latest version.') : result.code === 'name-duplicate' ? t('This name is already used by a tier or another assignment. Choose a different name.') : t('Could not save this assignment. Check its name, target and reasoning effort, then try again.'))
        return
      }
      onSaved(result.data)
    } catch {
      console.warn('[SubagentModels] Profile save failed; draft retained')
      setError(t('Could not save this assignment. Your changes are still here. Try again.'))
    } finally {
      busyRef.current = false
      setBusy(false)
      onBusyChange(false)
    }
  }
  return <form ref={form} aria-label={profile ? profileName(profile, t) : t('New custom assignment')} onSubmit={event => { event.preventDefault(); void save() }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); setDraftNotice(t('Your draft is still here. Use Cancel to discard it.')) } }} className="mt-4 space-y-4">
    <fieldset disabled={busy} className="min-w-0 space-y-4 border-0 p-0" aria-busy={busy}>
      {profile?.kind !== 'builtin' && <div className="space-y-1.5"><label htmlFor={`${id}-name`} className="text-sm font-medium">{t('Name')}</label><input id={`${id}-name`} value={name} onChange={event => setName(event.target.value)} maxLength={MODEL_SELECTION_LIMITS.nameCodePoints} className={fieldClass} required /></div>}
      <div className="space-y-1.5"><h4 className="text-sm font-medium">{t('Account and model')}</h4><TargetPicker config={config} value={target} onChange={next => { setTarget(next); setEffort('') }} /><p className="text-xs text-muted-foreground">{t('Subtask content is sent to the selected account’s provider. A load-balancing group may use another model in the group.')}</p></div>
      <div className="space-y-1.5"><label htmlFor={`${id}-purpose`} className="text-sm font-medium">{t('Suitable tasks')}</label><textarea id={`${id}-purpose`} value={description} onChange={event => setDescription(event.target.value)} maxLength={MODEL_SELECTION_LIMITS.descriptionCodePoints} rows={3} className={fieldClass} /></div>
      <Disclosure title={t('Reasoning effort')} hint={t('Follows the target model by default')}>
        <label htmlFor={`${id}-effort`} className="sr-only">{t('Reasoning effort')}</label>
        <select id={`${id}-effort`} value={effort} onChange={event => setEffort(event.target.value)} className={fieldClass}><option value="">{t('Target model default')}</option>{effort && !supportedEfforts.includes(effort) && <option value={effort} disabled>{t('Unsupported saved value')}</option>}{supportedEfforts.map(value => <option key={value} value={value}>{value}</option>)}</select>
        <p className="text-xs text-muted-foreground">{t('Only values supported by the selected model are accepted. Leave empty to use its default.')}</p>
      </Disclosure>
      {draftNotice && !error && <p role="status" className="break-words text-sm text-muted-foreground">{draftNotice}</p>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={onCancel} className="min-h-11 rounded-lg px-4 text-sm text-muted-foreground hover:bg-secondary sm:min-h-9">{t('Cancel')}</button><button type="submit" className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:min-h-9">{busy ? t('Saving...') : t('Save')}</button></div>
    </fieldset>
  </form>
}
