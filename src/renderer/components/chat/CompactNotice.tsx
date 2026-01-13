/**
 * CompactNotice - Displays a notice when context has been compressed
 *
 * Design principles:
 * - Appears as a system message in the conversation
 * - Subtle but informative
 * - Explains what happened in simple terms
 */

import { useTranslation } from '../../i18n'
import type { CompactInfo } from '../../types'

interface CompactNoticeProps extends CompactInfo {
  className?: string
}

// Format number to K format (e.g., 180000 -> "180K")
function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString()
  return `${Math.round(tokens / 1000)}K`
}

export function CompactNotice({ trigger, preTokens, className = '' }: CompactNoticeProps) {
  const { t } = useTranslation()

  return (
    <div className={`flex justify-center my-4 ${className}`}>
      <div className="inline-flex items-center gap-2 px-4 py-2 bg-secondary/50 rounded-full text-xs text-muted-foreground">
        <span className="w-1.5 h-1.5 bg-amber-500/60 rounded-full" />
        <span>
          {t('Context has been intelligently compressed')}
          {trigger === 'auto' && ` (${formatTokens(preTokens)} tokens)`}
        </span>
      </div>
    </div>
  )
}
