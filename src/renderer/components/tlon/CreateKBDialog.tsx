/**
 * CreateKBDialog — modal for creating a knowledge base (name + optional space
 * connections).
 */

import { useState, useEffect } from 'react'
import { useTranslation } from '../../i18n'
import { useTlonStore } from '../../stores/tlon.store'
import { useSpaceStore } from '../../stores/space.store'
import { Check } from 'lucide-react'

interface CreateKBDialogProps {
  onClose: () => void
  onCreated: (kbId: string) => void
}

export function CreateKBDialog({ onClose, onCreated }: CreateKBDialogProps) {
  const { t } = useTranslation()
  const createKB = useTlonStore(s => s.createKB)
  const bindSpace = useTlonStore(s => s.bindSpace)

  const haloSpace = useSpaceStore(s => s.haloSpace)
  const spaces = useSpaceStore(s => s.spaces)
  const loadSpaces = useSpaceStore(s => s.loadSpaces)

  const [name, setName] = useState('')
  const [selectedSpaces, setSelectedSpaces] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => { loadSpaces() }, [loadSpaces])

  const allSpaces = [...(haloSpace ? [haloSpace] : []), ...spaces]

  const toggleSpace = (id: string) => {
    setSelectedSpaces(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCreate = async () => {
    if (!name.trim() || submitting) return
    setSubmitting(true)
    const kbId = await createKB({ name: name.trim() })
    if (kbId) {
      for (const spaceId of Array.from(selectedSpaces)) {
        await bindSpace(kbId, spaceId)
      }
      onCreated(kbId)
    } else {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card border border-border rounded-xl p-5 sm:p-6 w-full max-w-md animate-fade-in max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-medium mb-4">{t('New knowledge base')}</h2>

        {/* Name */}
        <div className="mb-4">
          <label className="block text-sm text-muted-foreground mb-2">{t('Name')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) handleCreate() }}
            placeholder={t('My knowledge base')}
            className="w-full px-3 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors text-sm"
            autoFocus
          />
        </div>

        {/* Optional space connections */}
        {allSpaces.length > 0 && (
          <div className="mb-6">
            <label className="block text-sm text-muted-foreground mb-2">
              {t('Connect to spaces (optional)')}
            </label>
            <div className="flex flex-wrap gap-2">
              {allSpaces.map(space => {
                const selected = selectedSpaces.has(space.id)
                return (
                  <button
                    key={space.id}
                    onClick={() => toggleSpace(space.id)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-colors ${
                      selected
                        ? 'bg-primary/15 border-primary/40 text-primary'
                        : 'bg-secondary border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {selected && <Check className="w-3 h-3" />}
                    {space.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-muted-foreground hover:bg-secondary rounded-lg transition-colors text-sm"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || submitting}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('Create')}
          </button>
        </div>
      </div>
    </div>
  )
}
