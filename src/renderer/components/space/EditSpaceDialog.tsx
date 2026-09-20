/**
 * EditSpaceDialog
 *
 * Modal for renaming a dedicated space and changing its icon. Sibling to
 * CreateSpaceDialog (same overlay shell, same z-[60] so it sits above any
 * z-50 panel it was opened from, e.g. SpaceSelector's dropdown).
 */

import { useState } from 'react'
import { useTranslation } from '../../i18n'
import { useSpaceStore } from '../../stores/space.store'
import { SpaceColorSwatch } from './SpaceColorSwatch'
import { type SpaceColorId } from './spaceAvatarUtils'
import type { Space } from '../../types'

interface EditSpaceDialogProps {
  space: Space
  onClose: () => void
  onSaved: () => void
}

export function EditSpaceDialog({ space, onClose, onSaved }: EditSpaceDialogProps) {
  const { t } = useTranslation()
  const updateSpace = useSpaceStore(state => state.updateSpace)

  const [name, setName] = useState(space.name)
  const [color, setColor] = useState<SpaceColorId>((space.color as SpaceColorId) || 'primary')

  const handleSave = async () => {
    if (!name.trim()) return
    await updateSpace(space.id, { name: name.trim(), color })
    onSaved()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div
        className="bg-card border border-border rounded-xl p-6 w-full max-w-md animate-fade-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-4">{t('Edit Workspace')}</h2>

        <div className="mb-4">
          <label className="block text-sm text-muted-foreground mb-2">{t('Name')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('e.g. Payment Refactor')}
            className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
            autoFocus
          />
        </div>

        <div className="mb-6">
          <label className="block text-sm text-muted-foreground mb-2">{t('Icon Color')}</label>
          <SpaceColorSwatch value={color} onChange={setColor} />
        </div>

        <div className="flex justify-end gap-2.5">
          <button
            onClick={onClose}
            className="h-9 px-4 rounded-sm border border-border bg-secondary text-foreground text-[13px] font-medium hover:bg-surface-hover transition-colors ease-halo"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            className="h-9 px-4 rounded-sm border border-primary bg-primary text-primary-foreground text-[13px] font-medium hover:bg-primary-hover transition-colors ease-halo disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('Save')}
          </button>
        </div>
      </div>
    </div>
  )
}
