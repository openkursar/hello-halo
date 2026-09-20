/**
 * ToolsetControls — input-toolbar surface for the on-demand toolset broker.
 *
 * A single "Tools" button opens a catalog of toolsets, each a plain on/off
 * switch with a one-line capability description. Enabled toolsets are surfaced
 * on the button itself (tinted + their icons inline) instead of separate pills,
 * so the toolbar stays compact as toolsets grow. The AI cannot flip a switch
 * itself; when it needs a capability it calls request_toolset, which pulse-
 * highlights that switch (aiRequested) and pops this menu open.
 */

import { useEffect, useState } from 'react'
import { Wrench, Globe, TerminalSquare, ScanText, Settings2 } from 'lucide-react'
import { useToolsetsStore, type ToolsetStatus } from '../../stores/toolsets.store'
import { useChatStore } from '../../stores/chat.store'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation } from '../../i18n'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { Switch } from '../ui/Switch'

/** Icon per known toolset id; falls back to a generic tools glyph. */
function toolsetIcon(id: string, size = 15) {
  switch (id) {
    case 'ai-browser':
      return <Globe size={size} />
    case 'ai-terminal':
      return <TerminalSquare size={size} />
    case 'ocr':
      return <ScanText size={size} />
    case 'halo-api-ref':
      return <Settings2 size={size} />
    default:
      return <Wrench size={size} />
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
    case 'ocr':
      return t('Text Extraction (OCR)')
    case 'halo-api-ref':
      return t('Operate Halo')
    default:
      return ts.displayName
  }
}

/**
 * One-line capability description shown under each switch. Describes what
 * enabling grants the AI (literal t('...') so the extractor sees the keys);
 * falls back to the registry summary for any toolset not listed here.
 */
function toolsetDescription(t: (key: string) => string, ts: ToolsetStatus): string {
  switch (ts.id) {
    case 'ai-browser':
      return t('Let AI control your browser')
    case 'ai-terminal':
      return t('Let AI use interactive terminals')
    case 'ocr':
      return t('Let AI read text from images')
    case 'halo-api-ref':
      return t('Let AI manage Halo itself: spaces, digital humans, knowledge bases and settings')
    default:
      return ts.summary
  }
}

export function ToolsetControls() {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)

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

  if (!spaceId || !conversationId) return null

  const list: ToolsetStatus[] = statuses ?? []
  if (list.length === 0) return null

  const openList = list.filter((s) => s.open)

  const handleToggle = (ts: ToolsetStatus) => {
    if (ts.open) void closeToolset(spaceId, conversationId, ts.id)
    else void openToolset(spaceId, conversationId, ts.id)
  }

  return (
    <div className="flex items-center gap-1 shrink-0">
      {/* Catalog menu: portal-rendered so the toolbar's horizontal-scroll
          container (overflow clips vertically too) cannot hide it. */}
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger
          title={t('Tools')}
          className={`h-8 shrink-0 flex items-center gap-[5px] px-[9px] rounded-sm cursor-pointer transition-colors ease-halo
            ${menuOpen || openList.length > 0
              ? 'bg-primary/[0.12] text-accent-on-dark'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
            }`}
        >
          <Wrench size={17} />
          <span className="text-xs whitespace-nowrap">{t('Tools')}</span>
          {/* Enabled toolsets surfaced inline (icons only) — keeps the toolbar
              compact instead of rendering a separate pill per open toolset. */}
          {openList.length > 0 && (
            <span className="flex items-center gap-1 pl-1.5 ml-0.5 border-l border-primary/25">
              {openList.map((ts) => (
                <span key={ts.id} className="inline-flex" title={toolsetLabel(t, ts)}>
                  {toolsetIcon(ts.id, 14)}
                </span>
              ))}
            </span>
          )}
        </PopoverTrigger>

        <PopoverContent side="top" align="start" sideOffset={8} className="py-1.5 rounded-xl min-w-[260px]">
          {list.map((ts) => (
            // Row is the primary toggle; the Switch below is a nested control,
            // so this can't be a native <button> (no nested buttons) — same
            // role="button" pattern KnowledgeBaseButton uses for its rows.
            <div
              key={ts.id}
              role="button"
              tabIndex={0}
              onClick={() => handleToggle(ts)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handleToggle(ts)
                }
              }}
              className={`w-full px-3 py-2 flex items-start gap-3 text-left hover:bg-secondary cursor-pointer transition-colors
                ${aiRequested?.has(ts.id) && !ts.open ? 'animate-pulse-highlight rounded-lg' : ''}`}
            >
              <span className="mt-0.5 text-muted-foreground">{toolsetIcon(ts.id)}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-foreground">{toolsetLabel(t, ts)}</span>
                <span className="block text-xs text-muted-foreground/70 truncate">
                  {toolsetDescription(t, ts)}
                </span>
              </span>
              <span className="mt-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                <Switch checked={ts.open} onCheckedChange={() => handleToggle(ts)} size="sm" />
              </span>
            </div>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  )
}
