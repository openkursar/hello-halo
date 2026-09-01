/**
 * HeaderMoreMenu - desktop entry point for opening the built-in browser or a
 * space terminal as a Canvas tab.
 *
 * These used to be footer buttons on ArtifactRail. Same destination
 * (ContentCanvas, via useSpaceQuickActions), just moved out of the rail —
 * they're quick actions, not space resources, and this way they stay
 * reachable even when the rail is collapsed.
 */

import { Globe, TerminalSquare, Loader2, MoreHorizontal } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { useSpaceQuickActions } from '../../hooks/useSpaceQuickActions'
import { useTranslation } from '../../i18n'

interface HeaderMoreMenuProps {
  /** Forwarded to useSpaceQuickActions — e.g. collapse the resource rail to
   * hand the newly-opened browser tab its width back. */
  onBrowserOpened?: () => void
}

export function HeaderMoreMenu({ onBrowserOpened }: HeaderMoreMenuProps) {
  const { t } = useTranslation()
  const { canOpenBrowser, openBrowser, terminalAvailable, terminalCreating, openTerminal } = useSpaceQuickActions({ onBrowserOpened })

  if (!canOpenBrowser && !terminalAvailable) return null

  return (
    <div className="hidden sm:block">
      <Popover>
        <PopoverTrigger
          title={t('More')}
          className="p-1.5 hover:bg-secondary rounded-lg transition-colors text-muted-foreground hover:text-foreground"
        >
          <MoreHorizontal className="w-5 h-5" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 py-1">
          {canOpenBrowser && (
            <button
              onClick={openBrowser}
              className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-secondary/80 transition-colors"
            >
              <Globe className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
              <span>
                <span className="block text-sm text-foreground">{t('Open browser')}</span>
                <span className="block text-xs text-muted-foreground">{t('Built-in AI browser window')}</span>
              </span>
            </button>
          )}
          {terminalAvailable && (
            <button
              onClick={openTerminal}
              disabled={terminalCreating}
              className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-secondary/80 transition-colors disabled:opacity-60"
            >
              {terminalCreating ? (
                <Loader2 className="w-4 h-4 flex-shrink-0 mt-0.5 animate-spin" />
              ) : (
                <TerminalSquare className="w-4 h-4 text-violet-500 flex-shrink-0 mt-0.5" />
              )}
              <span>
                <span className="block text-sm text-foreground">{t('Open terminal')}</span>
                <span className="block text-xs text-muted-foreground">{t('Current space directory')}</span>
              </span>
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
