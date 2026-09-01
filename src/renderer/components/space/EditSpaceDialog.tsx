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
import { SpaceIcon } from '../icons/ToolIcons'
import { SPACE_ICONS, DEFAULT_SPACE_ICON } from '../../types'
import type { Space, SpaceIconId } from '../../types'

interface EditSpaceDialogProps {
  space: Space
  onClose: () => void
  onSaved: () => void
}

export function EditSpaceDialog({ space, onClose, onSaved }: EditSpaceDialogProps) {
  const { t } = useTranslation()
  const updateSpace = useSpaceStore(state => state.updateSpace)

  const [name, setName] = useState(space.name)
  const [icon, setIcon] = useState<SpaceIconId>((space.icon as SpaceIconId) || DEFAULT_SPACE_ICON)

  const handleSave = async () => {
    if (!name.trim()) return
    await updateSpace(space.id, { name: name.trim(), icon })
    onSaved()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div
        className="bg-card border border-border rounded-xl p-6 w-full max-w-md animate-fade-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-4">{t('Edit Space')}</h2>

        <div className="mb-4">
          <label className="block text-sm text-muted-foreground mb-2">{t('Space Name')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('My Project')}
            className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
            autoFocus
          />
        </div>

        <div className="mb-6">
          <label className="block text-sm text-muted-foreground mb-2">{t('Icon')}</label>
          <div className="flex flex-wrap gap-2">
            {SPACE_ICONS.map((iconId) => (
              <button
                key={iconId}
                onClick={() => setIcon(iconId)}
                className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                  icon === iconId
                    ? 'bg-primary/20 border-2 border-primary'
                    : 'bg-secondary hover:bg-secondary/80'
                }`}
              >
                <SpaceIcon iconId={iconId} size={20} />
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-muted-foreground hover:bg-secondary rounded-lg transition-colors"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('Save')}
          </button>
        </div>
      </div>
    </div>
  )
}
