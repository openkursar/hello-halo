/**
 * InterruptedBubble - Displays when model response was interrupted
 */

import { AlertTriangle, MessageSquare } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface InterruptedBubbleProps {
  onContinue?: () => void
  className?: string
}

export function InterruptedBubble({ onContinue, className = '' }: InterruptedBubbleProps) {
  const { t } = useTranslation()

  return (
    <div className={`flex justify-start animate-fade-in ${className}`}>
      <div className="w-[85%]">
        <div className="rounded-2xl px-4 py-3 bg-amber-500/10 border border-amber-500/30">
          {/* Header with icon and message */}
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <AlertTriangle size={16} className="shrink-0" />
            <span className="text-sm font-medium">
              {t('Model response interrupted')}
            </span>
          </div>

          {/* Description */}
          <p className="mt-2 text-sm text-amber-600/80 dark:text-amber-400/80">
            {t('The response was interrupted unexpectedly. You can continue the conversation.')}
          </p>

          {/* Action button */}
          {onContinue && (
            <div className="mt-3 flex justify-end">
              <button
                onClick={onContinue}
                className="
                  inline-flex items-center gap-1.5 px-3 py-1.5
                  text-sm font-medium text-amber-700 dark:text-amber-300
                  bg-amber-500/20 hover:bg-amber-500/30
                  rounded-lg transition-colors
                "
              >
                <MessageSquare size={14} />
                {t('Continue')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
