/**
 * CreateSpaceForm
 *
 * Pure form for creating a new dedicated space — no modal wrapper.
 * Can be embedded anywhere: inside a dialog shell or inline (accordion).
 *
 * Used by:
 *   - CreateSpaceDialog (wrapped in a modal, compact=false)
 *   - AppInstallDialog  (expanded inline accordion, compact=true)
 */

import { useState, useEffect, useRef, useCallback, useId } from 'react'
import { Monitor, FolderOpen } from 'lucide-react'
import { useSpaceStore } from '../../stores/space.store'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { DEFAULT_SPACE_ICON } from '../../types'
import { SpaceColorSwatch } from './SpaceColorSwatch'
import { type SpaceColorId } from './spaceAvatarUtils'
import type { Space } from '../../types'

const isWebMode = api.isRemoteMode()

export interface CreateSpaceFormProps {
  onCreated: (space: Space) => void
  onCancel: () => void
  /** Tighter spacing and smaller controls for inline / accordion contexts */
  compact?: boolean
}

export function CreateSpaceForm({ onCreated, onCancel, compact = false }: CreateSpaceFormProps) {
  const { t } = useTranslation()
  const createSpace = useSpaceStore(state => state.createSpace)

  const [name, setName] = useState('')
  // Icon glyph picking is gone from this form (replaced by the color swatch
  // below) — DEFAULT_SPACE_ICON is still sent silently since the backend's
  // `icon` field remains required; nothing renders it anymore.
  const [color, setColor] = useState<SpaceColorId>('primary')
  const [useCustomPath, setUseCustomPath] = useState(false)
  const [customPath, setCustomPath] = useState<string | null>(null)
  const [defaultPath, setDefaultPath] = useState<string>('~/.halo/spaces')

  // Unique radio group name so multiple form instances on the same page don't conflict
  const radioGroupName = useId()
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.getDefaultSpacePath().then((res) => {
      if (res.success && res.data) setDefaultPath(res.data as string)
    })
    setTimeout(() => nameInputRef.current?.focus(), 120)
  }, [])

  const shortenPath = (path: string) =>
    path.includes('/Users/') ? path.replace(/\/Users\/[^/]+/, '~') : path

  const handleSelectFolder = useCallback(async () => {
    if (isWebMode) return
    const res = await api.selectFolder()
    if (res.success && res.data) {
      const path = res.data as string
      setCustomPath(path)
      setUseCustomPath(true)
      const dirName = path.split(/[/\\]/).pop() || ''
      if (dirName && !name.trim()) setName(dirName)
      setTimeout(() => {
        nameInputRef.current?.focus()
        nameInputRef.current?.select()
      }, 100)
    }
  }, [name])

  const handleCreate = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const space = await createSpace({
      name: trimmed,
      icon: DEFAULT_SPACE_ICON,
      color,
      customPath: useCustomPath && customPath ? customPath : undefined,
    })
    if (space) onCreated(space)
  }, [name, color, useCustomPath, customPath, createSpace, onCreated])

  const canCreate = name.trim().length > 0 && !(useCustomPath && !customPath)

  // Responsive sizing tokens driven by compact mode
  const cardPad      = compact ? 'p-2.5'      : 'p-3'
  const inputPad     = compact ? 'py-1.5 px-3' : 'py-2 px-4'
  // Prototype `.btn`: height:36px, padding:0 16px — fixed height, horizontal
  // padding only. Compact (inline/accordion) context keeps a smaller variant
  // since the prototype has no analog for that embedding.
  const btnSize      = compact ? 'h-8 px-3.5' : 'h-9 px-4'
  const sectionGap   = compact ? 'space-y-3'  : 'space-y-4'
  const labelClass   = `block text-xs font-medium text-muted-foreground mb-1.5`

  return (
    <div className={sectionGap}>
      {/* Space name */}
      <div>
        <label className={labelClass}>{t('Name')}</label>
        <input
          ref={nameInputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && canCreate) handleCreate() }}
          placeholder={t('e.g. Payment Refactor')}
          className={`w-full ${inputPad} text-sm bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors`}
        />
      </div>

      {/* Storage location */}
      <div>
        <label className={labelClass}>{t('Local Directory')}</label>
        <div className="space-y-1.5">
          {/* Default location */}
          <label
            className={`flex items-center gap-2.5 ${cardPad} rounded-lg border cursor-pointer transition-all ${
              !useCustomPath
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <input
              type="radio"
              name={radioGroupName}
              checked={!useCustomPath}
              onChange={() => {
                setUseCustomPath(false)
                setTimeout(() => nameInputRef.current?.focus(), 100)
              }}
              className="w-3.5 h-3.5 text-primary flex-shrink-0"
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm leading-none mb-0.5">{t('Default Location')}</div>
              <div className="text-xs text-muted-foreground truncate">
                {shortenPath(defaultPath)}/{name || '…'}
              </div>
            </div>
          </label>

          {/* Custom location */}
          <label
            className={`flex items-center gap-2.5 ${cardPad} rounded-lg border transition-all ${
              isWebMode
                ? 'cursor-not-allowed opacity-60 border-border'
                : useCustomPath
                  ? 'cursor-pointer border-primary bg-primary/5'
                  : 'cursor-pointer border-border hover:border-muted-foreground/40'
            }`}
          >
            <input
              type="radio"
              name={radioGroupName}
              checked={useCustomPath}
              onChange={() => !isWebMode && setUseCustomPath(true)}
              disabled={isWebMode}
              className="w-3.5 h-3.5 text-primary flex-shrink-0"
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm leading-none mb-0.5">{t('Custom Folder')}</div>
              {isWebMode ? (
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  <Monitor className="w-3 h-3" />
                  {t('Please select folder in desktop app')}
                </div>
              ) : customPath ? (
                <div className="text-xs text-muted-foreground truncate">{shortenPath(customPath)}</div>
              ) : (
                <div className="text-xs text-muted-foreground">{t('Select an existing project or folder')}</div>
              )}
            </div>
            {!isWebMode && (
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); handleSelectFolder() }}
                className="flex-shrink-0 px-2.5 py-1 text-xs bg-secondary hover:bg-secondary/80 rounded-md flex items-center gap-1 transition-colors"
              >
                <FolderOpen className="w-3 h-3" />
                {t('Browse')}
              </button>
            )}
          </label>
        </div>
      </div>

      {/* Color */}
      <div>
        <label className={labelClass}>{t('Icon Color')}</label>
        <SpaceColorSwatch value={color} onChange={setColor} />
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2.5 pt-0.5">
        <button
          onClick={onCancel}
          className={`${btnSize} rounded-sm border border-border bg-secondary text-foreground text-[13px] font-medium hover:bg-surface-hover transition-colors ease-halo`}
        >
          {t('Cancel')}
        </button>
        <button
          onClick={handleCreate}
          disabled={!canCreate}
          className={`${btnSize} rounded-sm border border-primary bg-primary text-primary-foreground text-[13px] font-medium hover:bg-primary-hover transition-colors ease-halo disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {t('Create')}
        </button>
      </div>
    </div>
  )
}
