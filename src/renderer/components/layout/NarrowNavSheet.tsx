/**
 * NarrowNavSheet - shell-level destination menu for narrow layouts
 *
 * NavRail hides in a genuinely narrow layout (see useIsNarrowShell), so this
 * is its replacement entry point for Conversation / Digital Humans /
 * Knowledge Base / Store / Tasks / Settings — reachable from every
 * RAIL_VIEWS page, not just the one the user happens to be on. Without
 * this, deleting HomePage (their only other entry point for some of these)
 * would make those destinations permanently unreachable on a narrow layout.
 *
 * Same bottom-sheet interaction as MobileOverflowMenu, kept as a separate
 * component since the two serve different purposes (page-local actions vs.
 * rail destinations) and can appear together on SpacePage.
 */

import { useState } from 'react'
import { Menu, X, MessageSquare, Bot, BookOpen, Store, ListChecks, Settings } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTaskPanelStore } from '../../stores/taskPanel.store'
import { usePulseCount } from '../../stores/chat.store'
import { useTranslation } from '../../i18n'
import { useGoToConversation } from '../../hooks/useGoToConversation'

export function NarrowNavSheet() {
  const { t } = useTranslation()
  const navigate = useAppStore(s => s.navigate)
  const goToConversation = useGoToConversation()
  const taskCount = usePulseCount()
  const openTaskPanel = useTaskPanelStore(s => s.toggle)
  const [isOpen, setIsOpen] = useState(false)
  const [isAnimatingOut, setIsAnimatingOut] = useState(false)

  const close = (after?: () => void) => {
    setIsAnimatingOut(true)
    setTimeout(() => {
      setIsOpen(false)
      setIsAnimatingOut(false)
      after?.()
    }, 200)
  }

  const goChat = () => close(goToConversation)
  const goDigitalHumans = () => close(() => {
    useAppsPageStore.getState().setCurrentTab('my-digital-humans')
    navigate('apps')
  })
  const goKnowledge = () => close(() => navigate('tlon'))
  const goStore = () => close(() => {
    useAppsPageStore.getState().setCurrentTab('store')
    navigate('apps')
  })
  const goSettings = () => close(() => navigate('settings'))
  const goTasks = () => close(openTaskPanel)

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="no-drag p-1.5 hover:bg-secondary rounded-lg transition-colors flex-shrink-0"
        title={t('Navigate')}
        aria-label={t('Navigate')}
      >
        <Menu className="w-5 h-5" />
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => close()}
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
            <div className="flex justify-center py-2">
              <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
            </div>

            <div className="px-4 py-2 border-b border-border/50 flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground">{t('Navigate')}</h3>
              <button
                onClick={() => close()}
                className="p-2 hover:bg-secondary rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>

            <div className="py-1 pb-[env(safe-area-inset-bottom)]">
              <button
                onClick={goChat}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-secondary/80 transition-colors"
              >
                <MessageSquare className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm text-foreground">{t('Conversation')}</span>
              </button>

              <button
                onClick={goDigitalHumans}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-secondary/80 transition-colors"
              >
                <Bot className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm text-foreground">{t('Digital Humans')}</span>
              </button>

              <button
                onClick={goKnowledge}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-secondary/80 transition-colors"
              >
                <BookOpen className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm text-foreground">{t('Knowledge Base')}</span>
              </button>

              <button
                onClick={goStore}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-secondary/80 transition-colors"
              >
                <Store className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm text-foreground">{t('Store')}</span>
              </button>

              <button
                onClick={goTasks}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-secondary/80 transition-colors"
              >
                <ListChecks className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm text-foreground">{t('Tasks')}</span>
                {taskCount > 0 && (
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">{taskCount}</span>
                )}
              </button>

              <button
                onClick={goSettings}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-secondary/80 transition-colors"
              >
                <Settings className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm text-foreground">{t('Settings')}</span>
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
