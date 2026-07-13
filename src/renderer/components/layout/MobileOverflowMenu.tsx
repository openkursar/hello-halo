/**
 * MobileOverflowMenu - Mobile-only (< sm) header overflow menu
 *
 * Collapses low-frequency header actions (model selection, search, settings)
 * into a single "..." trigger to reduce mobile header crowding.
 * Opens a bottom sheet; the model row shows the current model name and
 * chains into ModelSelectSheet.
 */

import { useState } from 'react'
import { MoreHorizontal, Sparkles, Search, Settings, ChevronRight, X } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import { useChatStore } from '../../stores/chat.store'
import { getModelDisplayName, type AISourcesConfig } from '../../types'
import { useTranslation } from '../../i18n'
import { ModelSelectSheet } from './ModelSelector'

interface MobileOverflowMenuProps {
  onSearch: () => void
}

export function MobileOverflowMenu({ onSearch }: MobileOverflowMenuProps) {
  const { t } = useTranslation()
  const { config, setView } = useAppStore()
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isAnimatingOut, setIsAnimatingOut] = useState(false)
  const [isModelSheetOpen, setIsModelSheetOpen] = useState(false)

  const aiSources: AISourcesConfig = config?.aiSources?.version === 2
    ? config.aiSources
    : { version: 2, currentId: null, sources: [] }
  // Show the current conversation's pinned model (falls back to global selection).
  const currentConversation = useChatStore(s => {
    const conversationId = s.getCurrentSpaceState().currentConversationId
    return conversationId ? s.conversationCache.get(conversationId) ?? null : null
  })
  const currentModelName = getModelDisplayName(
    aiSources, currentConversation?.modelSourceId, currentConversation?.modelId
  )

  const closeMenu = (after?: () => void) => {
    setIsAnimatingOut(true)
    setTimeout(() => {
      setIsMenuOpen(false)
      setIsAnimatingOut(false)
      after?.()
    }, 200)
  }

  return (
    <div className="sm:hidden">
      <button
        onClick={() => setIsMenuOpen(true)}
        className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
        title={t('More')}
        aria-label={t('More')}
      >
        <MoreHorizontal className="w-5 h-5 text-muted-foreground" />
      </button>

      {isMenuOpen && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => closeMenu()}
            className={`fixed inset-0 bg-black/40 z-40 ${isAnimatingOut ? 'animate-fade-out' : 'animate-fade-in'}`}
            style={{ animationDuration: '0.2s' }}
          />

          {/* Bottom sheet */}
          <div
            className={`
              fixed inset-x-0 bottom-0 z-50
              bg-card rounded-t-2xl border-t border-border/50
              shadow-2xl overflow-hidden
              ${isAnimatingOut ? 'animate-slide-out-bottom' : 'animate-slide-in-bottom'}
            `}
          >
            {/* Drag handle */}
            <div className="flex justify-center py-2">
              <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
            </div>

            {/* Header */}
            <div className="px-4 py-2 border-b border-border/50 flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground">{t('More')}</h3>
              <button
                onClick={() => closeMenu()}
                className="p-2 hover:bg-secondary rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>

            <div className="py-1 pb-[env(safe-area-inset-bottom)]">
              {/* Model row: label + current value, chains into ModelSelectSheet */}
              <button
                onClick={() => closeMenu(() => setIsModelSheetOpen(true))}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-secondary/80 transition-colors"
              >
                <Sparkles className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm text-foreground">{t('Model')}</span>
                <span className="ml-auto text-sm text-muted-foreground truncate max-w-[160px]">
                  {currentModelName}
                </span>
                <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              </button>

              <button
                onClick={() => closeMenu(onSearch)}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-secondary/80 transition-colors"
              >
                <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm text-foreground">{t('Search')}</span>
              </button>

              <button
                onClick={() => closeMenu(() => setView('settings'))}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-secondary/80 transition-colors"
              >
                <Settings className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm text-foreground">{t('Settings')}</span>
              </button>
            </div>
          </div>
        </>
      )}

      {isModelSheetOpen && (
        <ModelSelectSheet onClose={() => setIsModelSheetOpen(false)} />
      )}
    </div>
  )
}
