/**
 * SettingsTab — rename/icon/status, connected spaces, watched folders, delete.
 *
 * Friendly terms: bound spaces are "Connected", linked dirs are "Watched folders".
 */

import { useState, useEffect } from 'react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { useTlonStore } from '../../stores/tlon.store'
import { useSpaceStore } from '../../stores/space.store'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { Trash2, FolderPlus, FolderOpen, X, Check, Pause, Play, RefreshCw } from 'lucide-react'
import type { KnowledgeBaseEntry } from '../../../shared/types/tlon'

interface SettingsTabProps {
  kb: KnowledgeBaseEntry
  onDeleted: () => void
}

export function SettingsTab({ kb, onDeleted }: SettingsTabProps) {
  const { t } = useTranslation()
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const updateKB = useTlonStore(s => s.updateKB)
  const deleteKB = useTlonStore(s => s.deleteKB)
  const clearAndRelearn = useTlonStore(s => s.clearAndRelearn)
  const bindSpace = useTlonStore(s => s.bindSpace)
  const unbindSpace = useTlonStore(s => s.unbindSpace)
  const addLinkedDir = useTlonStore(s => s.addLinkedDir)
  const removeLinkedDir = useTlonStore(s => s.removeLinkedDir)

  const haloSpace = useSpaceStore(s => s.haloSpace)
  const spaces = useSpaceStore(s => s.spaces)
  const loadSpaces = useSpaceStore(s => s.loadSpaces)

  const [name, setName] = useState(kb.name)
  const [description, setDescription] = useState(kb.description)

  useEffect(() => {
    loadSpaces()
  }, [loadSpaces])

  useEffect(() => {
    setName(kb.name)
    setDescription(kb.description)
  }, [kb.id, kb.name, kb.description])

  const allSpaces = [...(haloSpace ? [haloSpace] : []), ...spaces]
  const dirty = name.trim() !== kb.name || description !== kb.description
  const isPaused = kb.status === 'paused'

  const handleSave = async () => {
    if (!name.trim()) return
    await updateKB(kb.id, { name: name.trim(), description })
  }

  const handleDelete = async () => {
    const ok = await showConfirm({
      title: t('Delete knowledge base'),
      message: t('Delete "{{name}}"? This permanently removes its files and notes.', { name: kb.name }),
      confirmLabel: t('Delete'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (ok) {
      const success = await deleteKB(kb.id)
      if (success) onDeleted()
    }
  }

  const handleClearRelearn = async () => {
    const ok = await showConfirm({
      title: t('Clear & relearn'),
      message: t('Discard all AI notes and rebuild them from the source files? The sources are kept; only the generated notes are regenerated. This can take a while.'),
      confirmLabel: t('Clear & relearn'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (ok) await clearAndRelearn(kb.id)
  }

  const handleAddFolder = async () => {
    const res = await api.tlon.pickFolder()
    if (res.success && res.data) {
      const { filePaths, canceled } = res.data as { filePaths: string[]; canceled: boolean }
      if (canceled || !filePaths?.length) return
      for (const p of filePaths) {
        const label = p.split(/[\\/]/).filter(Boolean).pop() || p
        await addLinkedDir(kb.id, { path: p, label })
      }
    }
  }

  return (
    <div className="p-3 sm:p-4 space-y-6 max-w-2xl">
      {/* Identity */}
      <section className="space-y-3">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Details')}</h4>

        <div>
          <label className="block text-sm text-muted-foreground mb-1.5">{t('Name')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors text-sm"
          />
        </div>

        <div>
          <label className="block text-sm text-muted-foreground mb-1.5">{t('Description')}</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors text-sm resize-none"
          />
        </div>

        {dirty && (
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium btn-primary disabled:opacity-50"
          >
            <Check className="w-4 h-4" />
            {t('Save changes')}
          </button>
        )}
      </section>

      {/* Connected spaces */}
      <section className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Connected spaces')}</h4>
        <p className="text-xs text-muted-foreground">
          {t('Connected spaces can use this knowledge base in their conversations.')}
        </p>
        <div className="flex flex-wrap gap-2">
          {allSpaces.map(space => {
            const connected = kb.spaceIds.includes(space.id)
            return (
              <button
                key={space.id}
                onClick={() => connected ? unbindSpace(kb.id, space.id) : bindSpace(kb.id, space.id)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-colors ${
                  connected
                    ? 'bg-primary/15 border-primary/40 text-primary'
                    : 'bg-secondary border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {connected && <Check className="w-3 h-3" />}
                {space.name}
              </button>
            )
          })}
          {allSpaces.length === 0 && (
            <span className="text-xs text-muted-foreground">{t('No spaces available.')}</span>
          )}
        </div>
      </section>

      {/* Watched folders */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Watched folders')}</h4>
          {!api.isRemoteMode() && (
            <button
              onClick={handleAddFolder}
              className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              {t('Add folder')}
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('Halo keeps learning new and changed files inside watched folders.')}
        </p>
        <div className="space-y-1">
          {kb.linkedDirs.length === 0 ? (
            <span className="text-xs text-muted-foreground">{t('No watched folders.')}</span>
          ) : (
            kb.linkedDirs.map(dir => (
              <div
                key={dir.id}
                className="group flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card"
              >
                <FolderOpen className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{dir.label}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{dir.path}</p>
                </div>
                {!dir.watching && (
                  <span className="text-[11px] text-destructive flex-shrink-0">{t('Unavailable')}</span>
                )}
                <button
                  onClick={() => removeLinkedDir(kb.id, dir.id)}
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/20 transition-all flex-shrink-0"
                  title={t('Remove')}
                >
                  <X className="w-3.5 h-3.5 text-destructive" />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Status + delete */}
      <section className="space-y-3 pt-2 border-t border-border">
        <button
          onClick={() => updateKB(kb.id, { status: isPaused ? 'active' : 'paused' })}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg text-sm transition-colors"
        >
          {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
          {isPaused ? t('Resume learning') : t('Pause learning')}
        </button>

        <div>
          <button
            onClick={handleClearRelearn}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg text-sm transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            {t('Clear & relearn')}
          </button>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {t('Rebuilds AI notes from the source files. Use after adding many sources or to apply newer learning.')}
          </p>
        </div>

        <div>
          <button
            onClick={handleDelete}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            {t('Delete knowledge base')}
          </button>
        </div>
      </section>

      {DialogComponent}
    </div>
  )
}
