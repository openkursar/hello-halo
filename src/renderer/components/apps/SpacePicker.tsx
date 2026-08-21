/**
 * SpacePicker — pick an existing space or create a new one.
 *
 * Extracted from AppInstallDialog's "Install to" control so anywhere else that
 * needs the user to choose a destination space (e.g. team creation) gets the
 * same control, not a second hand-rolled one.
 */

import { useMemo, useState } from 'react'
import { FolderOpen, ChevronDown } from 'lucide-react'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation } from '../../i18n'
import { CreateSpaceForm } from '../space/CreateSpaceForm'

interface SpacePickerProps {
  selectedSpaceId: string
  onSelect: (spaceId: string) => void
  /** Defaults to "Install to" (the original wording); pass a task-specific label elsewhere. */
  label?: string
}

export function SpacePicker({ selectedSpaceId, onSelect, label }: SpacePickerProps) {
  const { t } = useTranslation()
  const spaces = useSpaceStore(s => s.spaces)
  const haloSpace = useSpaceStore(s => s.haloSpace)
  const [showCreateSpaceForm, setShowCreateSpaceForm] = useState(false)

  // Halo space first, then dedicated spaces — same order as the install dialog.
  const allSpaces = useMemo(
    () => (haloSpace ? [haloSpace, ...spaces] : spaces),
    [haloSpace, spaces]
  )

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label ?? t('Install to')}
      </h3>
      <select
        value={selectedSpaceId}
        onChange={e => onSelect(e.target.value)}
        className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
      >
        <option value="" disabled>{t('Select a space')}</option>
        {allSpaces.map(s => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      <div>
        <button
          onClick={() => setShowCreateSpaceForm(v => !v)}
          className={`flex items-center gap-1.5 text-xs transition-colors ${
            showCreateSpaceForm ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          <span>{t('New Space')}</span>
          <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${showCreateSpaceForm ? 'rotate-180' : ''}`} />
        </button>
        <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${showCreateSpaceForm ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="min-h-0 overflow-hidden">
            <div className="pt-2">
              <div className="rounded-lg border border-border bg-secondary/20 p-3">
                <CreateSpaceForm
                  compact
                  onCreated={space => { onSelect(space.id); setShowCreateSpaceForm(false) }}
                  onCancel={() => setShowCreateSpaceForm(false)}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
