/**
 * HeaderMoreMenu - desktop entry point for opening the built-in browser, a
 * space terminal or the changes view as a Canvas tab.
 *
 * These are quick actions rather than space resources, so they live here and
 * stay reachable when the artifact rail is collapsed.
 */

import { useState } from 'react'
import { Loader2, MoreHorizontal } from 'lucide-react'
import { BROWSER_META, TERMINAL_META, CHANGES_META } from '../canvas'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { CHANGES_SHORTCUT_LABEL, useSpaceQuickActions } from '../../hooks/useSpaceQuickActions'
import { useTranslation } from '../../i18n'
import { trackHome } from '../../services/home-telemetry'
import { trackToolOpen } from '../../services/tool-session-telemetry'

const BrowserIcon = BROWSER_META.icon
const TerminalIcon = TERMINAL_META.icon
const ChangesIcon = CHANGES_META.icon

export function HeaderMoreMenu() {
  const { t } = useTranslation()
  const {
    canOpenBrowser,
    openBrowser,
    terminalAvailable,
    terminalCreating,
    openTerminal,
    canOpenChanges,
    openChanges,
  } = useSpaceQuickActions()
  const [isOpen, setIsOpen] = useState(false)

  if (!canOpenBrowser && !terminalAvailable && !canOpenChanges) return null

  const handleOpenChange = (open: boolean) => {
    if (open && !isOpen) trackHome('home.header.action', { action: 'more', surface: 'desktop' })
    setIsOpen(open)
  }

  const handleOpenBrowser = () => {
    trackToolOpen('browser', 'more_menu', openBrowser())
  }

  const handleOpenTerminal = () => {
    trackToolOpen('terminal', 'more_menu', openTerminal())
  }

  const handleOpenChanges = () => {
    setIsOpen(false)
    void openChanges()
  }

  return (
    <div className="hidden sm:block">
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          title={t('More')}
          className="p-1.5 hover:bg-secondary rounded-lg transition-colors text-faint-foreground hover:text-foreground"
        >
          <MoreHorizontal className="w-5 h-5" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 py-1">
          {canOpenBrowser && (
            <button
              onClick={handleOpenBrowser}
              className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-secondary/80 transition-colors"
            >
              <BrowserIcon className={`w-4 h-4 ${BROWSER_META.color} flex-shrink-0 mt-0.5`} />
              <span>
                <span className="block text-sm text-foreground">{t('Open browser')}</span>
                <span className="block text-xs text-muted-foreground">{t('Built-in AI browser window')}</span>
              </span>
            </button>
          )}
          {terminalAvailable && (
            <button
              onClick={handleOpenTerminal}
              disabled={terminalCreating}
              className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-secondary/80 transition-colors disabled:opacity-60"
            >
              {terminalCreating ? (
                <Loader2 className="w-4 h-4 flex-shrink-0 mt-0.5 animate-spin" />
              ) : (
                <TerminalIcon className={`w-4 h-4 ${TERMINAL_META.color} flex-shrink-0 mt-0.5`} />
              )}
              <span>
                <span className="block text-sm text-foreground">{t('Open terminal')}</span>
                <span className="block text-xs text-muted-foreground">{t('Current workspace directory')}</span>
              </span>
            </button>
          )}
          {canOpenChanges && (
            <button
              onClick={handleOpenChanges}
              className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-secondary/80 transition-colors"
            >
              <ChangesIcon className={`w-4 h-4 ${CHANGES_META.color} flex-shrink-0 mt-0.5`} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2 text-sm text-foreground">
                  {t('Changes')}
                  <kbd className="font-sans text-[10px] leading-[15px] text-muted-foreground border border-border rounded px-1">{CHANGES_SHORTCUT_LABEL}</kbd>
                </span>
                <span className="block text-xs text-muted-foreground">{t('Review, stage and commit Git changes')}</span>
              </span>
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
