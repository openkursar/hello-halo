/**
 * ToolsetControls — input-toolbar surface for the on-demand toolset broker.
 *
 * Two coordinated pieces (ChatGPT-style):
 *  - Activation pills: one per OPEN toolset, click to close. AI-opened toolsets
 *    pulse briefly so the user notices the model turned a capability on.
 *  - Catalog menu: a "Tools" button opening the full toolset list with plain
 *    switches. Default (closed) reads "AI turns this on when needed" — there is
 *    no third "disabled" state; the switch is a simple on/off status + manual
 *    override, and the user can always instruct the AI in plain language.
 */

import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal, Globe, TerminalSquare, X } from 'lucide-react'
import { useToolsetsStore, type ToolsetStatus } from '../../stores/toolsets.store'
import { useChatStore } from '../../stores/chat.store'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation } from '../../i18n'

/** Icon per known toolset id; falls back to a generic tools glyph. */
function toolsetIcon(id: string, size = 15) {
  switch (id) {
    case 'ai-browser':
      return <Globe size={size} />
    case 'ai-terminal':
      return <TerminalSquare size={size} />
    default:
      return <SlidersHorizontal size={size} />
  }
}

/**
 * Localized display name. Uses literal t('...') calls (not t(ts.displayName))
 * so the i18n extractor can see the keys; the registry displayName is the
 * English fallback for any toolset not listed here.
 */
function toolsetLabel(t: (key: string) => string, ts: ToolsetStatus): string {
  switch (ts.id) {
    case 'ai-browser':
      return t('Web Control')
    case 'ai-terminal':
      return t('Terminal')
    default:
      return ts.displayName
  }
}

export function ToolsetControls() {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const currentSpace = useSpaceStore((s) => s.currentSpace)
  const getCurrentConversationId = useChatStore((s) => s.getCurrentConversationId)
  const conversationId = getCurrentConversationId()
  const spaceId = currentSpace?.id ?? null

  const statuses = useToolsetsStore((s) =>
    conversationId ? s.byConversation.get(conversationId) : undefined
  )
  const aiRequested = useToolsetsStore((s) =>
    conversationId ? s.aiRequested.get(conversationId) : undefined
  )
  const requestSignal = useToolsetsStore((s) =>
    conversationId ? s.requestSignal.get(conversationId) : undefined
  )
  const refresh = useToolsetsStore((s) => s.refresh)
  const openToolset = useToolsetsStore((s) => s.open)
  const closeToolset = useToolsetsStore((s) => s.close)
  const consumeRequestHighlight = useToolsetsStore((s) => s.consumeRequestHighlight)
  const consumeRequestSignal = useToolsetsStore((s) => s.consumeRequestSignal)

  // Load statuses when the active conversation changes.
  useEffect(() => {
    if (spaceId && conversationId) {
      void refresh(spaceId, conversationId)
    }
  }, [spaceId, conversationId, refresh])

  // When the AI asks the user to enable a toolset, pop the Tools menu open once so
  // the highlighted switch is visible. Consume the signal immediately so a later
  // remount/re-render (e.g. at turn-end) never re-opens the menu spuriously.
  useEffect(() => {
    if (requestSignal && conversationId) {
      setMenuOpen(true)
      consumeRequestSignal(conversationId)
    }
  }, [requestSignal, conversationId, consumeRequestSignal])

  // One-shot highlight: clear each requested flag after the animation so a switch
  // doesn't re-pulse on remount. Only runs while the menu is open (visible).
  useEffect(() => {
    if (!conversationId || !menuOpen || !aiRequested || aiRequested.size === 0) return
    const timers = Array.from(aiRequested).map((id) =>
      window.setTimeout(() => consumeRequestHighlight(conversationId, id), 2400)
    )
    return () => timers.forEach((tid) => window.clearTimeout(tid))
  }, [conversationId, menuOpen, aiRequested, consumeRequestHighlight])

  // Close the catalog menu on outside click.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  if (!spaceId || !conversationId) return null

  const list: ToolsetStatus[] = statuses ?? []
  if (list.length === 0) return null

  const openList = list.filter((s) => s.open)

  const handleToggle = (ts: ToolsetStatus) => {
    if (ts.open) void closeToolset(spaceId, conversationId, ts.id)
    else void openToolset(spaceId, conversationId, ts.id)
  }

  return (
    <div className="flex items-center gap-1">
      {/* Catalog menu trigger */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className={`h-8 flex items-center gap-1.5 px-2.5 rounded-lg transition-colors duration-200
            ${menuOpen
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50'
            }`}
          title={t('Tools')}
        >
          <SlidersHorizontal size={15} />
          <span className="text-xs">{t('Tools')}</span>
        </button>

        {menuOpen && (
          <div
            className="absolute bottom-full left-0 mb-2 py-1.5 bg-popover border border-border
              rounded-xl shadow-lg min-w-[260px] z-20 animate-fade-in"
          >
            {list.map((ts) => (
              <button
                key={ts.id}
                onClick={() => handleToggle(ts)}
                className={`w-full px-3 py-2 flex items-start gap-3 text-left hover:bg-muted/50 transition-colors
                  ${aiRequested?.has(ts.id) && !ts.open ? 'animate-pulse-highlight rounded-lg' : ''}`}
              >
                <span className="mt-0.5 text-muted-foreground">{toolsetIcon(ts.id)}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-foreground">{toolsetLabel(t, ts)}</span>
                  <span className="block text-xs text-muted-foreground/70 truncate">
                    {ts.open ? t('On') : t('AI turns this on when needed')}
                  </span>
                </span>
                {/* Switch */}
                <span
                  className={`mt-0.5 shrink-0 w-8 h-[18px] rounded-full transition-colors duration-200 relative
                    ${ts.open ? 'bg-primary' : 'bg-muted-foreground/25'}`}
                >
                  <span
                    className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-background
                      shadow transition-transform duration-200 ${ts.open ? 'translate-x-[14px]' : ''}`}
                  />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Activation pills for open toolsets */}
      {openList.map((ts) => {
        return (
          <button
            key={ts.id}
            onClick={() => void closeToolset(spaceId, conversationId, ts.id)}
            className="h-8 flex items-center gap-1.5 pl-2.5 pr-2 rounded-lg bg-primary/10 text-primary
              transition-colors duration-200 hover:bg-primary/20 group relative"
            title={t('Click to turn off')}
          >
            {toolsetIcon(ts.id)}
            <span className="text-xs">{toolsetLabel(t, ts)}</span>
            <X size={13} className="opacity-60 group-hover:opacity-100" />
          </button>
        )
      })}
    </div>
  )
}
