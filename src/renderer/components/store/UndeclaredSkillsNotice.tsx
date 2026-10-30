/**
 * Warns that a digital human's system prompt mentions skills its spec never
 * declared — publishing or exporting would leave them out — and offers to
 * declare the ones the author picks: a mention is not always a dependency.
 * Shared by the publish dialog and the share/export chooser.
 */

import { useCallback, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface UndeclaredSkillsNoticeProps {
  skillIds: string[]
  /** Skills the author unticked. Held by the dialog: the notice remounts while
   * the dependencies are checked again after each declaration. */
  unticked: string[]
  onUntickedChange: (ids: string[]) => void
  /** Declare `ids`; resolves false when the update failed. */
  onDeclare: (ids: string[]) => Promise<boolean>
}

export function UndeclaredSkillsNotice({ skillIds, unticked, onUntickedChange, onDeclare }: UndeclaredSkillsNoticeProps) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  // A newly listed skill starts ticked.
  const selected = skillIds.filter(id => !unticked.includes(id))
  const toggle = (id: string, on: boolean) => onUntickedChange(on ? unticked.filter(x => x !== id) : [...unticked, id])

  const declare = useCallback(async () => {
    setSaving(true)
    setFailed(false)
    const ok = await onDeclare(selected).catch(() => false)
    setFailed(!ok)
    setSaving(false)
  }, [onDeclare, selected])

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-halo-warning/30 bg-halo-warning/10 px-3 py-2.5 text-xs text-halo-warning">
      <div className="flex items-start gap-2 min-w-0">
        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        <span className="break-words">
          {t('The system prompt mentions these skills, but they are not declared as dependencies, so publishing or exporting this digital human leaves them out:')}
          {failed && <span className="block mt-1 text-halo-error">{t('Failed to update. Please try again.')}</span>}
        </span>
      </div>
      <div className="flex flex-col gap-2 pl-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 min-w-0">
          {skillIds.map(id => (
            <label key={id} className="inline-flex min-h-6 items-center gap-1.5 cursor-pointer text-foreground break-all">
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={e => toggle(id, e.target.checked)}
                disabled={saving}
                className="rounded border-border-soft"
              />
              {id}
            </label>
          ))}
        </div>
        <button
          onClick={declare}
          disabled={saving || selected.length === 0}
          className="self-start sm:self-auto flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {t('Add as dependencies')}
        </button>
      </div>
    </div>
  )
}
