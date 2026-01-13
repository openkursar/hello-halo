/**
 * SpaceGuide - Collapsible guide component for explaining space concepts
 *
 * Features:
 * - Collapsed by default, shows only title bar
 * - Expands to show full educational content
 * - Smooth slide animation
 * - Persistent state via localStorage
 * - Cross-platform & theme-aware
 */

import { useState, useEffect } from 'react'
import {
  ChevronDown,
  Zap,
  Folder,
  HelpCircle,
  AlertTriangle
} from 'lucide-react'
import { useTranslation } from '../../i18n'

// localStorage key for guide state
const GUIDE_STATE_KEY = 'halo-space-guide-expanded'

export function SpaceGuide() {
  const { t } = useTranslation()

  // Read initial state from localStorage, default to collapsed
  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(GUIDE_STATE_KEY)
      // Default to collapsed (false) for returning users
      // First time users will see collapsed, can expand if curious
      return saved === 'true'
    }
    return false
  })

  // Persist state to localStorage
  useEffect(() => {
    localStorage.setItem(GUIDE_STATE_KEY, String(isExpanded))
  }, [isExpanded])

  const toggleExpand = () => {
    setIsExpanded(!isExpanded)
  }

  return (
    <div className="mb-6 animate-fade-in">
      {/* Collapsed title bar - always visible */}
      <button
        onClick={toggleExpand}
        className="w-full flex items-center justify-between px-3 py-2.5 sm:p-3 rounded-lg bg-card border border-border hover:border-primary/30 transition-all group"
      >
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-md bg-primary/10 flex items-center justify-center">
            <HelpCircle className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-primary" />
          </div>
          <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
            {t('Learn what spaces are')}
          </span>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${
            isExpanded ? 'rotate-0' : '-rotate-90'
          }`}
        />
      </button>

      {/* Expanded content - no divider lines, use spacing instead */}
      {isExpanded && (
        <div className="mt-2 rounded-lg bg-card border border-border overflow-hidden animate-slide-down">
          <div className="p-3 sm:p-4 space-y-4 sm:space-y-5">
            {/* Section 1: What can AI do */}
            <div className="flex items-start gap-2.5 sm:gap-3">
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Zap className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-medium mb-1 sm:mb-1.5">{t('What can AI do?')}</h4>
                <div className="text-xs sm:text-sm text-muted-foreground leading-relaxed space-y-0.5 sm:space-y-1">
                  <p>{t('Halo is not just chat, it can help you do things')}</p>
                  <p>{t('Use natural language to have it write documents, create spreadsheets, search the web, write code...')}</p>
                  <p>{t('It can create, modify, and delete files')}</p>
                </div>
              </div>
            </div>

            {/* Section 2: What is a space */}
            <div className="flex items-start gap-2.5 sm:gap-3">
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-amber-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Folder className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-500" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-medium mb-1 sm:mb-1.5">{t('What is a space?')}</h4>
                <div className="text-xs sm:text-sm text-muted-foreground leading-relaxed space-y-0.5 sm:space-y-1">
                  <p>{t('AI-generated files (we call them "artifacts") need a place to be stored')}</p>
                  <p>{t('A space is their home, an independent folder')}</p>
                </div>
              </div>
            </div>

            {/* Section 3: When to create one */}
            <div className="flex items-start gap-2.5 sm:gap-3">
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <HelpCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-500" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-medium mb-1 sm:mb-1.5">{t('When do you need to create one?')}</h4>
                <div className="text-xs sm:text-sm text-muted-foreground leading-relaxed space-y-0.5 sm:space-y-1">
                  <p>
                    <span className="text-foreground/80">{t('Casual chat, asking questions')}</span>
                    <span className="mx-1 sm:mx-1.5">→</span>
                    {t('Use Halo space')}
                  </p>
                  <p>
                    <span className="text-foreground/80">{t('Projects, long-term tasks')}</span>
                    <span className="mx-1 sm:mx-1.5">→</span>
                    {t('Recommend creating a dedicated space')}
                  </p>
                  <p className="mt-1">{t('Keep files from different projects organized')}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Warning section - keep separate with subtle top border */}
          <div className="px-3 py-2.5 sm:p-3 bg-halo-warning/5 border-t border-border/50">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-halo-warning flex-shrink-0" />
              <p className="text-xs text-muted-foreground">
                <span className="text-halo-warning font-medium">{t('AI has delete permissions')}</span>
                {t(', be mindful of backing up important files')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
