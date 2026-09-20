/**
 * CreateSpaceDialog
 *
 * Modal shell for creating a new dedicated space.
 * Wraps CreateSpaceForm in a centered overlay — use this when you need
 * a standalone popup (e.g. SpaceSelector).
 *
 * For inline / accordion usage embed CreateSpaceForm directly.
 */

import { Lightbulb } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { CreateSpaceForm } from './CreateSpaceForm'
import type { Space } from '../../types'

interface CreateSpaceDialogProps {
  onClose: () => void
  onCreated: (space: Space) => void
}

export function CreateSpaceDialog({ onClose, onCreated }: CreateSpaceDialogProps) {
  const { t } = useTranslation()

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
    >
      <div
        className="bg-card border border-border rounded-xl p-6 w-full max-w-md max-h-[85vh] overflow-y-auto animate-fade-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-4">{t('Create Dedicated Workspace')}</h2>
        <div className="flex gap-1.5 rounded-md bg-primary/[0.12] px-3 py-2.5 mb-4 text-[11px] leading-relaxed text-muted-foreground">
          <Lightbulb className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-accent-on-dark" strokeWidth={1.8} />
          <span>
            <b className="text-accent-on-dark">{t('A workspace')}</b>
            {' '}
            {t('brings together a project\'s folder, conversations, knowledge base, digital humans, and installed skills — each kept isolated. Recommended: create one per project, client, or goal to avoid mixed context, and make reuse and collaboration easier.')}
          </span>
        </div>
        <CreateSpaceForm onCreated={onCreated} onCancel={onClose} />
      </div>
    </div>
  )
}
