/**
 * DigitalHumanSelector — main conversation board's input-area "recipient"
 * control.
 *
 * Docked at the input's left edge, a dropdown of the space's available
 * digital humans. "Halo" is not a list entry — listing it alongside digital
 * humans read as a mysterious extra category rather than "no selection".
 * Instead, once a digital human is selected the trigger itself grows a clear
 * ("x") affordance that switches straight back to Halo — the same "select
 * from a list to change, clear the chip to reset" pattern as a filter chip.
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
import { api } from '../../api'
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
      const res = await api.appSessionCreate(appId)
      if (res.success && res.data) {
        onChange(appId, res.data.conversationId)
      } else {
        console.error('[DigitalHumanSelector] Failed to create session:', res.error)
      }
    } catch (err) {
      console.error('[DigitalHumanSelector] Create session error:', err)
    } finally {
      setCreatingAppId(null)
    }
  }

  return (
    <>
      <div
        className={cn(
          'h-8 flex items-center rounded-sm text-xs font-medium transition-colors ease-halo max-w-[160px] shrink-0',
          currentOption ? 'bg-secondary text-foreground' : ''
        )}
      >
        <button
          ref={buttonRef}
          type="button"
          disabled={locked}
          onClick={toggleOpen}
          className={cn(
            'h-full flex items-center gap-1.5 pl-2 rounded-sm min-w-0',
            currentOption ? 'pr-1' : 'pr-2',
            locked && 'opacity-50 cursor-not-allowed',
            !currentOption && 'text-muted-foreground hover:text-foreground hover:bg-secondary'
          )}
          title={
            locked
              ? t('Switch recipient after the current reply finishes')
              : currentOption ? t('Chatting with {{name}}', { name: currentOption.name }) : t('Chat with a digital human')
          }
        >
          {currentOption ? (
            <AutomationAvatar name={currentOption.name} size={16} />
          ) : (
            <Bot className="w-3.5 h-3.5" />
          )}
          <span className="truncate">{currentOption ? currentOption.name : t('Digital human')}</span>
          <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
        </button>

        {currentOption && (
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
        )}
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
