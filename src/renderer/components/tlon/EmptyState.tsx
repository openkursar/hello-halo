/**
 * EmptyState — first-run 3-step guide shown when no KB is selected
 * (or no KBs exist yet).
 */

import { useTranslation } from '../../i18n'
import { BookOpen, FilePlus2, Sparkles, Plus } from 'lucide-react'

interface EmptyStateProps {
  onCreate: () => void
  hasKBs: boolean
}

export function EmptyState({ onCreate, hasKBs }: EmptyStateProps) {
  const { t } = useTranslation()

  const steps = [
    { icon: Plus, title: t('Create a knowledge base'), desc: t('Give it a name and an icon.') },
    { icon: FilePlus2, title: t('Add your files'), desc: t('Drop in text files or watch a folder.') },
    { icon: Sparkles, title: t('Let Halo learn'), desc: t('Halo turns your files into notes it can use in chat.') },
  ]

  return (
    <div className="h-full flex flex-col items-center justify-center p-6 sm:p-10 text-center">
      <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-5">
        <BookOpen className="w-7 h-7 text-primary" />
      </div>
      <h2 className="text-base sm:text-lg font-semibold">
        {hasKBs ? t('Select a knowledge base') : t('Build your first knowledge base')}
      </h2>
      <p className="mt-1.5 text-sm text-muted-foreground max-w-sm">
        {t('Knowledge bases let Halo remember your documents and use them when answering.')}
      </p>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-2xl">
        {steps.map((step, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-4 text-left">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center flex-shrink-0">
                {i + 1}
              </span>
              <step.icon className="w-4 h-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">{step.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{step.desc}</p>
          </div>
        ))}
      </div>

      <button
        onClick={onCreate}
        className="mt-7 inline-flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium btn-primary"
      >
        <Plus className="w-4 h-4" />
        {t('New knowledge base')}
      </button>
    </div>
  )
}
