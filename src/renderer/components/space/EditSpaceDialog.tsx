/**
 * EditSpaceDialog
 *
 * Modal for editing a dedicated space: its name, icon color, working
 * directory, and — folded under Advanced — its shared memory. Sibling to CreateSpaceDialog (same
 * overlay shell, same z-[60] so it sits above any z-50 panel it was opened
 * from, e.g. SpaceSelector's dropdown).
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { useSpaceStore } from '../../stores/space.store'
import { api } from '../../api'
import { SpaceColorSwatch } from './SpaceColorSwatch'
import { useChangeWorkingDir } from './useChangeWorkingDir'
import { Disclosure } from '../ui/Disclosure'
import { MemorySettingsPanel } from '../memory/MemorySettingsPanel'
import { spaceColorId, type SpaceColorId } from './spaceAvatarUtils'
import type { Space } from '../../types'
import {
  resolveMemorySettings,
  type MemorySettings,
  type MemoryStatus,
  type ResolvedMemorySettings,
} from '../../../shared/types/memory'

interface EditSpaceDialogProps {
  space: Space
  onClose: () => void
  onSaved: () => void
}

export function EditSpaceDialog({ space, onClose, onSaved }: EditSpaceDialogProps) {
  const { t } = useTranslation()
  const updateSpace = useSpaceStore(state => state.updateSpace)
  const updateSpacePreferences = useSpaceStore(state => state.updateSpacePreferences)

  const [name, setName] = useState(space.name)
  const [color, setColor] = useState<SpaceColorId>(() => spaceColorId(space))
  const { change: changeWorkingDir, status: workingDirStatus, available: folderPickerAvailable } = useChangeWorkingDir(space.id)
  const workingDir = workingDirStatus.state === 'changed' ? workingDirStatus.workingDir : (space.workingDir || space.path)
  // The list entry carries no preferences, so the memory settings are read when
  // the dialog opens; the controls stay disabled until then, so a choice made
  // before they arrive cannot be overwritten by them.
  const [memory, setMemory] = useState<ResolvedMemorySettings>(resolveMemorySettings(space.preferences?.memory))
  const [initialMemory, setInitialMemory] = useState<ResolvedMemorySettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Unknown settings stay unknown: controls remain disabled rather than show
  // defaults that saving would then write over the real ones.
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.getSpacePreferences(space.id).then(res => {
      if (cancelled) return
      if (!res.success) throw new Error(res.error ?? 'unknown error')
      const loaded = resolveMemorySettings((res.data as { memory?: MemorySettings } | null)?.memory)
      setMemory(loaded)
      setInitialMemory(loaded)
    }).catch(err => {
      console.error('[EditSpaceDialog] Failed to load space preferences:', err)
      if (!cancelled) setLoadFailed(true)
    })
    return () => { cancelled = true }
  }, [space.id])

  const loadStatus = useCallback(async (): Promise<MemoryStatus | null> => {
    const res = await api.getSpaceMemoryStatus(space.id)
    return res.success ? res.data ?? null : null
  }, [space.id])

  const consolidateNow = useCallback(async () => {
    const res = await api.consolidateSpaceMemory(space.id)
    return res.success ? res.data ?? null : null
  }, [space.id])

  // Only the fields the owner changed are sent; the service merges them.
  const memoryChanges: MemorySettings = {}
  if (initialMemory) {
    if (memory.enabled !== initialMemory.enabled) memoryChanges.enabled = memory.enabled
    if (memory.autoConsolidate !== initialMemory.autoConsolidate) memoryChanges.autoConsolidate = memory.autoConsolidate
    if (memory.cadence !== initialMemory.cadence) memoryChanges.cadence = memory.cadence
  }
  const memoryChanged = Object.keys(memoryChanges).length > 0

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await updateSpace(space.id, { name: name.trim(), color })
      if (memoryChanged && !(await updateSpacePreferences(space.id, { memory: memoryChanges }))) {
        setError(t('Memory settings could not be saved. Please try again.'))
        return
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div
        className="bg-card border border-border rounded-xl p-4 sm:p-6 w-full max-w-md max-h-[90vh] overflow-y-auto animate-fade-in"
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

        <div className="mb-4">
          <label className="block text-sm text-muted-foreground mb-2">{t('Icon Color')}</label>
          <SpaceColorSwatch value={color} onChange={setColor} />
        </div>

        {/* Applies at once, apart from Save: the folder is what the AI and the
            file panel already use, not a draft of this form. */}
        <div className="mb-4">
          <label className="block text-sm text-muted-foreground mb-2">{t('Working directory')}</label>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 px-3 py-2 text-xs font-mono bg-input rounded-lg border border-border truncate" title={workingDir}>
              {workingDir}
            </div>
            <button
              onClick={() => void changeWorkingDir()}
              disabled={!folderPickerAvailable || workingDirStatus.state === 'changing'}
              className="h-9 px-3 flex-shrink-0 rounded-sm border border-border bg-secondary text-foreground text-[13px] font-medium hover:bg-surface-hover transition-colors ease-halo disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('Change folder')}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {workingDirStatus.state === 'changed'
              ? t('Changed. Conversations keep their history; any reply in progress finishes first.')
              : folderPickerAvailable
                ? t('Where the AI works and what the file panel shows. Nothing in either folder is moved.')
                : t('The folder can only be changed in the desktop app.')}
          </p>
          {workingDirStatus.state === 'failed' && (
            <p className="mt-1 text-xs text-destructive">
              {t('Could not change the working directory: {{error}}', { error: workingDirStatus.error })}
            </p>
          )}
        </div>

        <div className="mb-6">
          <Disclosure title={t('Advanced')}>
            <div>
              <div className="text-sm text-muted-foreground mb-1">{t('Workspace memory')}</div>
              <p className="text-xs text-muted-foreground mb-3">
                {t('Conversations in this workspace share one memory: lasting decisions, preferences and know-how, organized into topics. Changes apply to new conversations.')}
              </p>
              <MemorySettingsPanel
                settings={memory}
                onChange={next => setMemory(resolveMemorySettings(next))}
                disabled={initialMemory === null || saving}
                loadStatus={loadStatus}
                consolidateNow={consolidateNow}
              />
              {loadFailed && (
                <p className="mt-3 text-xs text-destructive">
                  {t('Memory settings could not be loaded. Close and reopen this dialog to try again.')}
                </p>
              )}
            </div>
          </Disclosure>
        </div>
        {error && <p className="mb-3 text-xs text-destructive">{error}</p>}

        <div className="flex justify-end gap-2.5">
          <button
            onClick={onClose}
            className="h-9 px-4 rounded-sm border border-border bg-secondary text-foreground text-[13px] font-medium hover:bg-surface-hover transition-colors ease-halo"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="h-9 px-4 rounded-sm border border-primary bg-primary text-primary-foreground text-[13px] font-medium hover:bg-primary-hover transition-colors ease-halo disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('Save')}
          </button>
        </div>
      </div>
    </div>
  )
}
