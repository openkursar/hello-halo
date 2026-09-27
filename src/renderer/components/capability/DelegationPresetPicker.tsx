/**
 * The permission question asked at the moment a team crosses machines.
 *
 * Inviting someone, or joining someone's office, is the one point where a
 * person is already thinking about who they are about to work with — and it is
 * the last point before a stranger's digital human can start asking theirs to
 * do things. Asking later means either asking at a moment the question makes no
 * sense, or not asking at all and hoping the default was right.
 *
 * So it is asked here, and asked coarsely: three answers, no tool list. The
 * fine-grained switches live on the member itself, where someone who wants them
 * will go looking; a screen that opened with them would turn "invite a
 * colleague" into a permissions review.
 */

import { CAPABILITY_PRESET_IDS } from '../../../shared/apps/capability-policy'
import type { CapabilityPresetId } from '../../../shared/apps/capability-policy'
import { useTranslation } from '../../i18n'

interface DelegationPresetPickerProps {
  value: CapabilityPresetId
  onChange: (preset: CapabilityPresetId) => void
  /** What the choice is about, in this screen's words. */
  title: string
  /** Who the permission is being granted to. */
  subtitle: string
}

export function DelegationPresetPicker({
  value,
  onChange,
  title,
  subtitle,
}: DelegationPresetPickerProps) {
  const { t } = useTranslation()

  const copy: Record<CapabilityPresetId, { label: string; description: string }> = {
    read_only: {
      label: t('Read only'),
      description: t('It can read, search and look things up for them. It cannot change anything on your computer.'),
    },
    workspace: {
      label: t('Read and write files'),
      description: t('It can also write files in its own space. It still cannot run commands.'),
    },
    full: {
      label: t('Everything it can normally do'),
      description: t('The same reach it has when you work with it yourself, including running commands.'),
    },
  }

  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>
      <p className="mb-1.5 text-xs text-muted-foreground/70">{subtitle}</p>
      <div className="flex flex-col gap-1.5">
        {CAPABILITY_PRESET_IDS.map(id => {
          const selected = value === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/50'
              }`}
            >
              <span className="block text-sm text-foreground">{copy[id].label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{copy[id].description}</span>
            </button>
          )
        })}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground/70">
        {t('You can change this per digital human afterwards, and see everything it was asked to do.')}
      </p>
    </div>
  )
}
