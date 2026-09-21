/**
 * DigitalHumanSelector — main conversation board's input-area "recipient"
 * chip.
 *
 * Renders only while a digital human is selected; with no selection it is
 * absent from the toolbar entirely, because "sending to Halo" is the default
 * and needs no control to say so. Choosing a recipient in the first place
 * happens through the "@" menu (reachable by typing "@" or from the "+"
 * menu), so this chip is purely the standing indication of "this goes to
 * someone else", plus the two things only it can do: switch to a different
 * digital human, or clear ("x") straight back to Halo.
 *
 * Locked (disabled, not hidden) while generating or with queued messages, so
 * a reply in flight can never land in the wrong session.
 *
 * The dropdown is a portal to document.body: the trigger sits inside the
 * input toolbar's `overflow-x-auto` row, which clips any child positioned
 * with `absolute` — a portal is the only way to escape that.
 *
 * Picking a digital human here — same as @-mentioning one in the input —
 * always starts a fresh session (`appSessionCreate`): this control is for
 * starting a conversation, not resuming one. Resuming an existing session
 * happens by clicking its row in the left conversation list, which already
 * carries a specific conversationId.
 */

import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Bot, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { AutomationAvatar } from '../apps/AutomationAvatar'
import { cn } from '../../lib/utils'
import { startDigitalHumanConversation } from '../../utils/conversation-navigation'
import type { AppStatus } from '../../../shared/apps/app-types'

export interface DigitalHumanSelectorOption {
  appId: string
  name: string
  status: AppStatus
}

export interface DigitalHumanSelectorConfig {
  /** Selected digital human's appId, or null for "Halo" (normal chat). */
  current: string | null
  options: DigitalHumanSelectorOption[]
  /**
   * Switch the active link. `conversationId` targets one specific session of
   * `appId` (a digital human can have several). This component always passes
   * the id of a session it just created.
   */
  onChange: (appId: string | null, conversationId?: string) => void
  /** Generating or queued — dropdown opens but every option stays disabled. */
  locked: boolean
}

export function DigitalHumanSelector({ current, options, onChange, locked }: DigitalHumanSelectorConfig) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // Anchored to the viewport (`bottom` measured from the trigger's top edge,
  // not the menu's own height) so the menu always grows upward from the
  // trigger without needing to know its rendered height in advance.
  const [menuPosition, setMenuPosition] = useState<{ bottom: number; left: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [open])

  const toggleOpen = () => {
    if (locked) return
    if (!open) {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (rect) setMenuPosition({ bottom: window.innerHeight - rect.top + 8, left: rect.left })
    }
    setOpen(o => !o)
  }

  const currentOption = options.find(o => o.appId === current) ?? null
  const [creatingAppId, setCreatingAppId] = useState<string | null>(null)

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (locked) return
    onChange(null)
    setOpen(false)
  }

  const handlePick = async (appId: string) => {
    setOpen(false)
    setCreatingAppId(appId)
    try {
      const conversationId = await startDigitalHumanConversation(appId)
      if (conversationId) onChange(appId, conversationId)
    } finally {
      setCreatingAppId(null)
    }
  }

  if (current === null) return null

  return (
    <>
      <div className="h-8 flex items-center rounded-sm text-xs font-medium bg-secondary text-foreground transition-colors ease-halo max-w-[160px] shrink-0">
        <button
          ref={buttonRef}
          type="button"
          disabled={locked}
          onClick={toggleOpen}
          className={cn(
            'h-full flex items-center gap-1.5 pl-2 pr-1 rounded-sm min-w-0',
            locked && 'opacity-50 cursor-not-allowed'
          )}
          title={
            locked
              ? t('Switch recipient after the current reply finishes')
              : currentOption ? t('Chatting with {{name}}', { name: currentOption.name }) : t('Chat with a digital human')
          }
        >
          {/* Falls back to a generic label when the selected app is gone
              (uninstalled mid-conversation) — the chip must still render, or
              there is no way left to clear back to Halo. */}
          {currentOption ? (
            <AutomationAvatar name={currentOption.name} size={16} />
          ) : (
            <Bot className="w-3.5 h-3.5" />
          )}
          <span className="truncate">{currentOption ? currentOption.name : t('Digital human')}</span>
          <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
        </button>

        <button
          type="button"
          disabled={locked}
          onClick={handleClear}
          title={t('Switch back to Halo')}
          aria-label={t('Switch back to Halo')}
          className={cn(
            'h-full flex items-center pr-2 pl-0.5 rounded-sm shrink-0',
            locked ? 'opacity-50 cursor-not-allowed' : 'hover:text-destructive'
          )}
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          className="fixed w-56 max-h-72 overflow-y-auto bg-popover border border-border rounded-xl shadow-lg z-[9999] py-1"
          style={{ bottom: menuPosition.bottom, left: menuPosition.left }}
        >
          {options.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">{t('No digital humans in this workspace yet.')}</p>
          )}

          {options.map(option => {
            const disabled = (locked && option.appId !== current) || creatingAppId !== null
            const paused = option.status === 'paused'
            return (
              <button
                key={option.appId}
                type="button"
                disabled={disabled}
                onClick={() => { void handlePick(option.appId) }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                  option.appId === current ? 'bg-secondary text-foreground' : 'hover:bg-muted/50',
                  disabled && 'opacity-40 cursor-not-allowed'
                )}
              >
                <AutomationAvatar name={option.name} size={20} />
                <span className="flex-1 min-w-0 truncate text-left">{option.name}</span>
                {paused && <span className="text-[10px] text-muted-foreground shrink-0">{t('Paused')}</span>}
              </button>
            )
          })}
        </div>,
        document.body
      )}
    </>
  )
}
