/**
 * Conversation List - Resizable sidebar for multiple conversations
 * Self-contained: subscribes to its own data from stores, no data props from parent.
 * Supports drag-to-resize, inline title editing, and conversation management.
 */

import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import { Virtuoso } from 'react-virtuoso'
import { Plus } from '../icons/ToolIcons'
import { EllipsisVertical, Pin, Pencil, Trash2, ChevronRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useChatStore, useAllConversationStatuses } from '../../stores/chat.store'
import { useSpaceStore } from '../../stores/space.store'
import { useAppStore } from '../../stores/app.store'
import { useAppChatPinsStore } from '../../stores/app-chat-pins.store'
import { api } from '../../api'
import { cn } from '../../lib/utils'
import { TaskStatusDot } from '../pulse/TaskStatusDot'
import { EngineBadge } from './EngineBadge'
import { AutomationAvatar } from '../apps/AutomationAvatar'
import { useAppChatConversationRows, type AppChatConversationRow } from '../../hooks/useAppChatConversationRows'
import { parseAppChatKey } from '../../../shared/apps/im-keys'
import { NATIVE_SESSION_CHANNEL, NATIVE_DEFAULT_CHAT_ID } from '../../../shared/types/im-channel'
import type { ConversationMeta } from '../../types'

// Width constraints (in pixels)
const MIN_WIDTH = 140
const MAX_WIDTH = 360
const DEFAULT_WIDTH = 260
// Dragging the resize handle below this width snaps into the same 56px
// icon-strip view the canvas-open `collapsed` prop uses — dragging it back
// out past the same threshold restores the normal list.
const DRAG_COLLAPSE_THRESHOLD = 100
const clampWidth = (v: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v))

interface ConversationListProps {
  /** Canvas-open collapsed mode — 56px icon strip: grouping/pin hidden,
   * each conversation is just a status dot (prototype's
   * `.body.canvas-open .conv`). Resizing is disabled in this mode. */
  collapsed?: boolean
}


/**
 * Registry coordinates for a digital-human session. The default session's key
 * has no channel/chatId segments to parse, so it uses the synthetic pair the
 * runtime registers it under.
 */
function appChatRegistryTarget(row: AppChatConversationRow): { channel: string; chatId: string } {
  const parsed = parseAppChatKey(row.id)
  return parsed
    ? { channel: parsed.channel, chatId: parsed.chatId }
    : { channel: NATIVE_SESSION_CHANNEL, chatId: NATIVE_DEFAULT_CHAT_ID }
}

/**
 * Conversation timestamp: clock time for today, weekday-less date beyond it.
 * Kept narrower than `formatTimeAgo` because it has to fit beside a title in a
 * 140–360px sidebar without truncating it. The hover card reuses it so the same
 * conversation never shows two different times.
 */
function formatRowTime(timestamp: string | number, t: (s: string) => string): string {
  const d = new Date(timestamp)
  const ms = d.getTime()
  if (!ms) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return t('Yesterday')
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
  }
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'numeric', day: 'numeric' })
}

/**
 * Same shape as conversation.service.ts's generateTitle() ("Chat M-D H:MM"),
 * so a fresh digital-human session reads like a fresh regular conversation
 * instead of the more generic, slightly misleading "New chat". Computed here
 * rather than persisted server-side: local-session displayName is left empty
 * on purpose so the renderer can localize this fallback (see
 * im-session-registry.ts's createLocalSession doc comment).
 */
function formatDefaultChatTitle(timestamp: number, t: (s: string, opts?: Record<string, unknown>) => string): string {
  const d = new Date(timestamp)
  const minute = d.getMinutes().toString().padStart(2, '0')
  return t('Chat {{date}}', { date: `${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${minute}` })
}

/**
 * What distinguishes one session of the same digital human from another.
 * Inside its own section the digital human's name/avatar is already on the
 * sub-header, so a row shows only this; the collapsed rail has no header at
 * all and pairs it with the owner's name instead.
 */
function appChatSessionLabel(row: AppChatConversationRow, t: (s: string, opts?: Record<string, unknown>) => string): string {
  return row.isDefault
    ? (row.lastMessage || t('No messages yet'))
    : (row.customName || row.displayName.trim() || row.lastMessage || formatDefaultChatTitle(row.updatedAt, t))
}

/** What the hover card shows for a row, in either list form. */
function hoverCardFor(
  row: Extract<ConversationRow, { type: 'item' | 'dh-item' }>,
  t: (s: string, opts?: Record<string, unknown>) => string,
): { label: string; owner?: string; time?: string } {
  if (row.type === 'dh-item') {
    return {
      label: appChatSessionLabel(row.row, t),
      owner: row.row.digitalHumanName,
      time: formatRowTime(row.row.updatedAt, t),
    }
  }
  return {
    label: row.conversation.title || t('New conversation'),
    time: formatRowTime(row.conversation.updatedAt, t),
  }
}

/** Flattened row fed to `Virtuoso` — headers and items share one list instead
 * of nested groups, matching the existing flat-row approach (see history:
 * `GroupedVirtuoso`'s separate groups API had a rendering bug where
 * header/item data could desync). */
type ConversationRow =
  /** `hint` is hover-only: the distinction between sections is one-time
   *  knowledge, not worth permanent vertical space in a 140px-wide sidebar.
   *  Omitted where the label already says everything. */
  | { type: 'header'; key: string; label: string; hint?: string }
  | { type: 'item'; key: string; conversation: ConversationMeta }
  | { type: 'dh-header'; key: string; appId: string; name: string; uninstalled: boolean; collapsed: boolean; count: number }
  /** `standalone` rows sit outside their digital human's section (i.e. in
   *  Pinned), so they carry the avatar/name context the section header would
   *  otherwise provide. */
  | { type: 'dh-item'; key: string; row: AppChatConversationRow; standalone: boolean }

/**
 * Build the full flat row list:
 *   Pinned (flat, mixes regular + digital-human items)
 *   → Digital humans (per-app collapsible sub-header, its sessions beneath)
 *   → Conversations (regular ones, newest first)
 *
 * Empty sections are dropped entirely.
 */
function buildConversationRows(
  conversations: ConversationMeta[],
  appChatRows: AppChatConversationRow[],
  collapsedApps: Set<string>,
  t: (key: string) => string
): ConversationRow[] {
  const pinnedConvs: ConversationMeta[] = []
  const rest: ConversationMeta[] = []

  for (const conv of conversations) {
    if (conv.starred) pinnedConvs.push(conv)
    else rest.push(conv)
  }

  const pinnedDh: AppChatConversationRow[] = []
  const byApp = new Map<string, AppChatConversationRow[]>()
  for (const row of appChatRows) {
    if (row.starred) {
      pinnedDh.push(row)
      continue
    }
    const list = byApp.get(row.appId) ?? []
    list.push(row)
    byApp.set(row.appId, list)
  }

  const out: ConversationRow[] = []

  if (pinnedConvs.length || pinnedDh.length) {
    out.push({ type: 'header', key: 'header:pinned', label: t('Pinned') })
    for (const conv of pinnedConvs) out.push({ type: 'item', key: conv.id, conversation: conv })
    for (const row of pinnedDh) out.push({ type: 'dh-item', key: row.id, row, standalone: true })
  }

  if (byApp.size > 0) {
    out.push({ type: 'header', key: 'header:digital-humans', label: t('Digital Humans'), hint: t('Conversations with digital humans available in this workspace') })
    for (const [appId, rows] of byApp) {
      if (rows.length === 0) continue
      const collapsed = collapsedApps.has(appId)
      out.push({
        type: 'dh-header',
        key: `dh-header:${appId}`,
        appId,
        name: rows[0].digitalHumanName,
        uninstalled: rows[0].uninstalled,
        collapsed,
        count: rows.length,
      })
      if (!collapsed) {
        for (const row of rows) out.push({ type: 'dh-item', key: row.id, row, standalone: false })
      }
    }
  }

  if (rest.length) {
    out.push({ type: 'header', key: 'header:conversations', label: t('Conversations'), hint: t('Your direct conversations with Halo') })
    for (const conv of rest) out.push({ type: 'item', key: conv.id, conversation: conv })
  }

  return out
}

export const ConversationList = memo(function ConversationList({
  collapsed = false,
}: ConversationListProps) {
  const { t } = useTranslation()

  // Self-subscribe to data from stores (precise selectors)
  const currentSpaceId = useChatStore(state => state.currentSpaceId)
  const conversations = useChatStore(state => {
    const spaceState = state.spaceStates.get(state.currentSpaceId ?? '')
    return spaceState?.conversations ?? []
  })
  const currentConversationId = useChatStore(state => {
    const spaceState = state.spaceStates.get(state.currentSpaceId ?? '')
    return spaceState?.currentConversationId ?? undefined
  })
  const selectedAppChat = useChatStore(state => {
    const spaceState = state.spaceStates.get(state.currentSpaceId ?? '')
    return spaceState?.selectedAppChat ?? null
  })
  const layoutConfig = useAppStore(state => state.config?.layout)

  const allAppChatRows = useAppChatConversationRows(currentSpaceId)
  const toggleAppChatPin = useAppChatPinsStore(s => s.toggleAppChatPin)

  // Which digital-human sub-groups are collapsed (their session rows hidden).
  // Not persisted — a purely transient viewing preference.
  const [collapsedApps, setCollapsedApps] = useState<Set<string>>(new Set())
  const toggleAppCollapsed = useCallback((appId: string) => {
    setCollapsedApps(prev => {
      const next = new Set(prev)
      if (next.has(appId)) next.delete(appId)
      else next.add(appId)
      return next
    })
  }, [])

  // Single batch subscription for all conversation statuses (replaces N individual hooks)
  const conversationStatuses = useAllConversationStatuses()

  // Width state - initialized from persisted config
  const initialWidth = layoutConfig?.sidebarWidth
  const [width, setWidth] = useState(initialWidth != null ? clampWidth(initialWidth) : DEFAULT_WIDTH)
  const [isDragging, setIsDragging] = useState(false)
  // Drag-triggered version of the canvas-open `collapsed` prop — lets the
  // user reach the same icon-strip view by dragging the handle instead of
  // only via the canvas. Independent of `collapsed`; combined below.
  const [isDragCollapsed, setIsDragCollapsed] = useState(false)
  const widthRef = useRef(width)

  // Sync width when config arrives asynchronously
  useEffect(() => {
    if (initialWidth !== undefined && !isDragging) {
      const clamped = clampWidth(initialWidth)
      setWidth(clamped)
      widthRef.current = clamped
    }
  }, [initialWidth, isDragging])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const editContainerRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLInputElement | null>(null)
  const focusedEditingIdRef = useRef<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** Hovered row's identity card — rows truncate their title and the
   * collapsed rail shows no title at all, so both lean on this. `owner` is
   * set for a digital human's session. */
  const [hoverCard, setHoverCard] = useState<{
    label: string
    owner?: string
    time?: string
    top: number
    left: number
  } | null>(null)

  const showHoverCard = useCallback((
    el: HTMLElement,
    card: { label: string; owner?: string; time?: string },
  ) => {
    const r = el.getBoundingClientRect()
    setHoverCard({ ...card, top: r.top + r.height / 2, left: r.right + 8 })
  }, [])
  const hideHoverCard = useCallback(() => setHoverCard(null), [])

  const rows = useMemo<ConversationRow[]>(
    () => buildConversationRows(conversations, allAppChatRows, collapsedApps, t),
    [conversations, allAppChatRows, collapsedApps, t]
  )

  // Handle drag resize
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return
      const containerRect = containerRef.current.getBoundingClientRect()
      const newWidth = e.clientX - containerRect.left
      if (newWidth < DRAG_COLLAPSE_THRESHOLD) {
        setIsDragCollapsed(true)
        return
      }
      setIsDragCollapsed(false)
      const clampedWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth))
      setWidth(clampedWidth)
      widthRef.current = clampedWidth
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      // Persist width to in-memory store + backend config
      const currentConfig = useAppStore.getState().config
      if (currentConfig) {
        useAppStore.getState().updateConfig({ layout: { ...currentConfig.layout, sidebarWidth: widthRef.current } })
      }
      api.setConfig({ layout: { sidebarWidth: widthRef.current } }).catch(err =>
        console.error('[ConversationList] Failed to persist sidebar width:', err)
      )
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  // Close dropdown menu on outside click
  useEffect(() => {
    if (!menuOpenId) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null)
        setMenuPosition(null)
      }
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [menuOpenId])

  // Reset menu state when conversations change (e.g. space switch)
  useEffect(() => {
    setMenuOpenId(null)
    setMenuPosition(null)
  }, [conversations])

  useEffect(() => {
    if (!editingId) {
      focusedEditingIdRef.current = null
    }
  }, [editingId])

  const attachEditInputRef = useCallback((input: HTMLInputElement | null) => {
    editInputRef.current = input
    if (!input || !editingId || focusedEditingIdRef.current === editingId) return

    focusedEditingIdRef.current = editingId
    input.focus()
    input.select()
  }, [editingId])

  // Start editing a conversation title
  const handleStartEdit = (e: React.MouseEvent, conv: ConversationMeta) => {
    e.stopPropagation()
    setEditingId(conv.id)
    setEditingTitle(conv.title || '')
  }

  // Save edited title. `editingId` is a conversationId for both kinds of row;
  // digital-human sessions live in the session registry, not the space's
  // conversation index, so they rename through a different call.
  const handleSaveEdit = () => {
    const name = editingTitle.trim()
    if (editingId && name) {
      const appChatRow = allAppChatRows.find(r => r.id === editingId)
      if (appChatRow) {
        const target = appChatRegistryTarget(appChatRow)
        void api.imSessionsSetCustomName({ appId: appChatRow.appId, ...target, name })
      } else {
        const spaceId = useSpaceStore.getState().currentSpace?.id
        if (spaceId) {
          useChatStore.getState().renameConversation(spaceId, editingId, name)
        }
      }
    }
    setEditingId(null)
    setEditingTitle('')
  }

  // Cancel editing
  const handleCancelEdit = () => {
    setEditingId(null)
    setEditingTitle('')
  }

  // Handle input key events
  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleCancelEdit()
    }
  }

  const handleEditBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const nextTarget = e.relatedTarget
    if (nextTarget instanceof Node && editContainerRef.current?.contains(nextTarget)) {
      return
    }
    handleSaveEdit()
  }

  const handleTogglePin = (e: React.MouseEvent, conv: ConversationMeta) => {
    e.stopPropagation()
    const spaceId = useSpaceStore.getState().currentSpace?.id
    if (spaceId) useChatStore.getState().toggleStarConversation(spaceId, conv.id, !conv.starred)
  }

  const openMoreMenu = (e: React.MouseEvent, conversationId: string) => {
    e.stopPropagation()
    setPendingDeleteAppChatId(null)
    if (menuOpenId === conversationId) {
      setMenuOpenId(null)
      setMenuPosition(null)
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const MENU_HEIGHT_ESTIMATE = 90
    const spaceBelow = window.innerHeight - rect.bottom - 4
    const top = spaceBelow >= MENU_HEIGHT_ESTIMATE
      ? rect.bottom + 4
      : Math.max(4, rect.top - MENU_HEIGHT_ESTIMATE - 4)
    setMenuPosition({ top, left: rect.right })
    setMenuOpenId(conversationId)
  }

  // ── Digital-human row actions ──
  // Read the space id fresh at call time (matches handleTogglePin/handleSaveEdit
  // above) rather than closing over the render-scoped `currentSpaceId` — these
  // handlers are captured inside a `useCallback` (renderAppChatItem) with a
  // narrower dep list, so a stale closure would otherwise keep an old space id.
  const handleSelectAppChat = (row: AppChatConversationRow) => {
    const spaceId = useSpaceStore.getState().currentSpace?.id
    if (!spaceId) return
    useChatStore.getState().selectAppChatConversation(spaceId, row.appId, row.id)
  }

  const handleToggleAppChatPin = (e: React.MouseEvent, row: AppChatConversationRow) => {
    e.stopPropagation()
    const spaceId = useSpaceStore.getState().currentSpace?.id
    if (spaceId) toggleAppChatPin(spaceId, row.id)
  }

  // Two-step confirm inside the same portal menu used for regular
  // conversations — deleting a digital-human session is more consequential
  // (loses agent context / permanently drops a local session) than renaming
  // a title, so it gets a confirm step regular conversations don't.
  const [pendingDeleteAppChatId, setPendingDeleteAppChatId] = useState<string | null>(null)

  const handleDeleteAppChat = async (row: AppChatConversationRow) => {
    const spaceId = useSpaceStore.getState().currentSpace?.id
    if (!spaceId) return
    try {
      const res = row.isDefault
        ? await api.appChatClear(row.appId, spaceId, row.id)
        : await api.appSessionDelete(row.appId, spaceId, row.id)
      if (res.success) {
        useChatStore.getState().resetSession(row.id)
      }
    } catch (err) {
      console.error('[ConversationList] Delete app-chat session error:', err)
    } finally {
      setPendingDeleteAppChatId(null)
      setMenuOpenId(null)
      setMenuPosition(null)
    }
  }

  // Render a single conversation item (used by GroupedVirtuoso)
  const renderConversationItem = useCallback((conversation: ConversationMeta) => {
    const status = conversationStatuses.get(conversation.id) ?? 'idle'
    // currentConversationId stays pointed at the last regular conversation
    // even while a digital human is selected (switching back lands there
    // unchanged) — so this row must not read as "active" during that time,
    // or it and the digital-human's row would both show selected at once.
    const isActive = conversation.id === currentConversationId && !selectedAppChat
    const isEditing = editingId === conversation.id

    return (
      <div
        onClick={() => !isEditing && useChatStore.getState().selectConversation(conversation.id)}
        onMouseEnter={(e) => showHoverCard(e.currentTarget, hoverCardFor({ type: 'item', key: conversation.id, conversation }, t))}
        onMouseLeave={hideHoverCard}
        className={cn(
          'group relative flex w-full items-center gap-1.5 rounded-sm pl-2.5 pr-1.5 py-1.5 text-[13px] transition-colors ease-halo cursor-pointer',
          isActive
            ? 'bg-secondary text-foreground font-medium'
            : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
        )}
      >
        {isActive && (
          <span className="absolute left-0 top-[7px] bottom-[7px] w-[2.5px] rounded-[2px] bg-primary" />
        )}

        {isEditing ? (
          <div ref={editContainerRef} className="flex flex-1 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <input
              ref={attachEditInputRef}
              type="text"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onKeyDown={handleEditKeyDown}
              onBlur={handleEditBlur}
              className="flex-1 text-sm bg-input border border-border rounded px-2 py-1 focus:outline-none focus:border-primary min-w-0"
              placeholder={t('Conversation title...')}
            />
            <button
              onClick={handleSaveEdit}
              className="p-1 hover:bg-primary/20 text-primary rounded transition-colors flex-shrink-0"
              title={t('Save')}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </button>
          </div>
        ) : (
          <>
            {/* Status dot — inline, left of the title, only when non-idle
                (prototype: `.ci-dot`, only rendered when a conversation has
                a `run`/`done` state). Kept as the existing 4-state
                TaskStatusDot rather than reduced to the prototype's plain
                two states — the richer state set is an existing strength
                by design, not a prototype-vs-implementation mismatch to fix. */}
            {status !== 'idle' && <TaskStatusDot status={status} size="sm" />}

            <span className="flex-1 min-w-0 truncate">{conversation.title}</span>

            <EngineBadge engineId={conversation.engineId} size="xs" />

            <span className="shrink-0 text-[11px] tabular-nums text-subtle-foreground group-hover:hidden">
              {formatRowTime(conversation.updatedAt, t)}
            </span>

            <button
              onClick={(e) => handleTogglePin(e, conversation)}
              className={cn(
                'ml-auto w-[22px] h-[22px] flex-shrink-0 rounded-[6px] hidden group-hover:flex items-center justify-center transition-colors',
                conversation.starred
                  ? 'text-accent-on-dark'
                  : 'text-subtle-foreground hover:bg-surface-hover hover:text-foreground'
              )}
              title={conversation.starred ? t('Unpin') : t('Pin')}
              aria-pressed={conversation.starred}
            >
              <Pin className="w-[13px] h-[13px]" strokeWidth={1.8} />
            </button>

            <button
              onClick={(e) => openMoreMenu(e, conversation.id)}
              className="w-[22px] h-[22px] flex-shrink-0 rounded-[6px] flex items-center justify-center text-subtle-foreground opacity-0 group-hover:opacity-100 transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:opacity-100"
              title={t('More')}
            >
              <EllipsisVertical className="w-[13px] h-[13px]" strokeWidth={1.8} />
            </button>
          </>
        )}
      </div>
    )
  }, [editingId, editingTitle, currentConversationId, selectedAppChat, conversationStatuses, t])

  // Render a single digital-human conversation row. Uninstalled digital
  // humans fade out and become non-interactive rather than disappearing —
  // reinstalling the app restores the row automatically since it's derived
  // live from the apps list each render.
  const renderAppChatItem = useCallback((row: AppChatConversationRow, standalone: boolean) => {
    const isActive = row.id === selectedAppChat?.conversationId
    const isEditing = editingId === row.id
    const sessionLabel = appChatSessionLabel(row, t)
    const status = conversationStatuses.get(row.id) ?? 'idle'

    return (
      <div
        onClick={() => !isEditing && !row.uninstalled && handleSelectAppChat(row)}
        onMouseEnter={(e) => showHoverCard(e.currentTarget, hoverCardFor({ type: 'dh-item', key: row.id, row, standalone }, t))}
        onMouseLeave={hideHoverCard}
        className={cn(
          'group relative flex w-full items-center gap-1.5 rounded-sm pr-1.5 py-1.5 text-[13px] transition-colors ease-halo',
          standalone ? 'pl-2.5' : 'pl-5',
          row.uninstalled
            ? 'opacity-40 cursor-not-allowed'
            : 'cursor-pointer',
          isActive && !row.uninstalled
            ? 'bg-secondary text-foreground font-medium'
            : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
        )}
      >
        {isActive && !row.uninstalled && (
          <span className="absolute left-0 top-[7px] bottom-[7px] w-[2.5px] rounded-[2px] bg-primary" />
        )}

        {standalone && <AutomationAvatar name={row.digitalHumanName} size={16} />}

        {status !== 'idle' && <TaskStatusDot status={status} size="sm" />}

        {isEditing ? (
          <div ref={editContainerRef} className="flex flex-1 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <input
              ref={attachEditInputRef}
              type="text"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onKeyDown={handleEditKeyDown}
              onBlur={handleEditBlur}
              className="flex-1 text-sm bg-input border border-border rounded px-2 py-1 focus:outline-none focus:border-primary min-w-0"
              placeholder={t('Conversation title...')}
            />
          </div>
        ) : (
          <span className="flex-1 min-w-0 truncate">
            {standalone && row.isDefault ? row.digitalHumanName : sessionLabel}
          </span>
        )}
        {row.status === 'paused' && !isEditing && (
          <span className="text-[11px] text-muted-foreground shrink-0">{t('Paused')}</span>
        )}

        <span className="shrink-0 text-[11px] tabular-nums text-subtle-foreground group-hover:hidden">
          {formatRowTime(row.updatedAt, t)}
        </span>

        {!row.uninstalled && (
          <>
            <button
              onClick={(e) => handleToggleAppChatPin(e, row)}
              className={cn(
                'ml-auto w-[22px] h-[22px] flex-shrink-0 rounded-[6px] hidden group-hover:flex items-center justify-center transition-colors',
                row.starred
                  ? 'text-accent-on-dark'
                  : 'text-subtle-foreground hover:bg-surface-hover hover:text-foreground'
              )}
              title={row.starred ? t('Unpin') : t('Pin')}
              aria-pressed={row.starred}
            >
              <Pin className="w-[13px] h-[13px]" strokeWidth={1.8} />
            </button>

            <button
              onClick={(e) => openMoreMenu(e, row.id)}
              className="w-[22px] h-[22px] flex-shrink-0 rounded-[6px] flex items-center justify-center text-subtle-foreground opacity-0 group-hover:opacity-100 transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:opacity-100"
              title={t('More')}
            >
              <EllipsisVertical className="w-[13px] h-[13px]" strokeWidth={1.8} />
            </button>
          </>
        )}
      </div>
    )
  }, [selectedAppChat?.conversationId, editingId, editingTitle, conversationStatuses, t])

  // Fixed-positioned and portaled: the row lists scroll, and a scroll
  // container clips anything reaching past its edge.
  const hoverCardPortal = hoverCard && !editingId && createPortal(
    <div
      role="tooltip"
      style={{ top: hoverCard.top, left: hoverCard.left }}
      className="pointer-events-none fixed z-[60] w-[260px] -translate-y-1/2 rounded-lg border border-border bg-popover px-3.5 py-3 shadow-lg"
    >
      {hoverCard.owner && (
        <span className="mb-1.5 flex items-center gap-2">
          <AutomationAvatar name={hoverCard.owner} size={20} />
          <span className="truncate text-[13px] text-muted-foreground">{hoverCard.owner}</span>
        </span>
      )}
      <span className="block text-sm leading-relaxed text-foreground line-clamp-3">{hoverCard.label}</span>
      {hoverCard.time && (
        <span className="mt-1.5 block text-xs text-muted-foreground">{hoverCard.time}</span>
      )}
    </div>,
    document.body
  )

  if (collapsed || isDragCollapsed) {
    // Canvas-driven collapse (`collapsed`) has no drag handle — the canvas
    // dictates the layout, dragging it back open would immediately fight
    // with that. Drag-triggered collapse (`isDragCollapsed`) keeps the
    // handle so the same drag gesture can pull it back out.
    const showDragHandle = !collapsed
    return (
      <div
        ref={showDragHandle ? containerRef : undefined}
        className="relative w-14 h-full flex-shrink-0 border-r border-border bg-background flex flex-col items-center"
      >
        <div className="w-full px-2 pt-2.5 pb-1.5">
          <button
            onClick={() => {
              const spaceId = useSpaceStore.getState().currentSpace?.id
              if (spaceId) useChatStore.getState().createConversation(spaceId)
            }}
            className="flex h-9 w-full items-center justify-center rounded-sm border border-primary/[0.18] bg-primary/[0.12] text-accent-on-dark transition-colors ease-halo hover:bg-primary/[0.18]"
            title={t('New conversation')}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        {/* Same rows as the expanded list, minus its section headers, so
            collapsing never drops a conversation the open list shows. Dots
            carry no label of their own, so the hover bubble is the only way
            to tell them apart; it is portaled and fixed-positioned because
            this column scrolls, and a scroll container clips anything
            reaching past its edge. */}
        <div className="flex-1 w-full overflow-y-auto px-2 py-1 flex flex-col items-center gap-1.5">
          {rows.map(row => {
            if (row.type === 'header' || row.type === 'dh-header') return null
            const isAppChat = row.type === 'dh-item'
            const id = isAppChat ? row.row.id : row.conversation.id
            const active = isAppChat
              ? row.row.id === selectedAppChat?.conversationId
              : row.conversation.id === currentConversationId && !selectedAppChat
            const status = conversationStatuses.get(id) ?? 'idle'
            return (
              <button
                key={row.key}
                onClick={() => {
                  if (isAppChat) {
                    if (!row.row.uninstalled) handleSelectAppChat(row.row)
                  } else {
                    useChatStore.getState().selectConversation(row.conversation.id)
                  }
                }}
                onMouseEnter={(e) => showHoverCard(e.currentTarget, hoverCardFor(row, t))}
                onMouseLeave={hideHoverCard}
                className="flex h-5 w-8 items-center justify-center"
              >
                {/* Busy/attention states win over the plain dot: with the list
                    collapsed this is the only place that state is visible. */}
                {status !== 'idle' ? (
                  <TaskStatusDot status={status} size="md" />
                ) : (
                  <span className={cn(
                    'w-[7px] h-[7px] rounded-full transition-colors ease-halo',
                    active ? 'bg-primary opacity-100' : 'bg-subtle-foreground opacity-50'
                  )} />
                )}
              </button>
            )
          })}
        </div>
        {hoverCardPortal}
        {showDragHandle && (
          <div
            className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/50 transition-colors z-20 ${
              isDragging ? 'bg-primary/50' : ''
            }`}
            onMouseDown={handleMouseDown}
            title={t('Drag to resize width')}
          />
        )}
      </div>
    )
  }

  return (
    <>
    <div
      ref={containerRef}
      className="border-r border-border flex flex-col bg-background relative"
      style={{ width, transition: isDragging ? 'none' : 'width 0.2s ease' }}
    >
      <div className="flex flex-col gap-2 px-2.5 pt-4 pb-3">
        <button
          onClick={() => {
            const spaceId = useSpaceStore.getState().currentSpace?.id
            if (spaceId) useChatStore.getState().createConversation(spaceId)
          }}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-sm border border-primary/[0.18] bg-primary/[0.12] text-xs font-medium text-accent-on-dark transition-colors ease-halo hover:bg-primary/[0.18]"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('New conversation')}
        </button>
      </div>

      {/* Conversation list - virtualized for performance with large lists */}
      <div className="flex-1 overflow-hidden">
        <Virtuoso
            data={rows}
            overscan={200}
            // Virtuoso's scroller only sets overflow-y, which leaves overflow-x
            // resolving to `auto` — a stray pixel of row width then shows a
            // horizontal scrollbar under a list that never scrolls sideways.
            className="px-2 pt-1 pb-3 overflow-x-hidden"
            itemContent={(index, row) => {
              if (row.type === 'header') {
                // No uppercase/letter-spacing: both are no-ops on CJK labels
                // and only loosen them oddly.
                return (
                  <div className={cn(
                    'bg-background px-1.5 pb-1 text-xs font-medium text-subtle-foreground/70',
                    index === 0 ? 'pt-1' : 'mt-4 pt-2.5 border-t border-border/50'
                  )}>
                    <span title={row.hint} className="cursor-default">{row.label}</span>
                  </div>
                )
              }
              if (row.type === 'dh-header') {
                return (
                  <button
                    type="button"
                    onClick={() => toggleAppCollapsed(row.appId)}
                    className={cn(
                      // pr = the rows' own 10px padding plus the 22px their
                      // always-rendered (opacity-0) "more" button occupies, so
                      // this count lands on the same right edge as their
                      // timestamps instead of hugging the container.
                      'group w-full flex items-center gap-1.5 rounded-sm pl-0.5 pr-8 py-1.5 mt-0.5 text-[13px] font-medium transition-colors ease-halo',
                      row.uninstalled
                        ? 'opacity-40 cursor-not-allowed'
                        : 'text-foreground hover:bg-secondary'
                    )}
                  >
                    <ChevronRight className={cn(
                      'w-3 h-3 shrink-0 text-subtle-foreground transition-transform',
                      !row.collapsed && 'rotate-90'
                    )} />
                    <AutomationAvatar name={row.name} size={18} />
                    <span className="flex-1 min-w-0 truncate text-left">{row.name}</span>
                    {/* Only while collapsed: expanded, the sessions are right
                        there to count. Sits on the same right edge as their
                        timestamps (see the pr above). */}
                    {row.collapsed && (
                      <span className="shrink-0 ml-1 text-[11px] tabular-nums text-subtle-foreground">
                        {row.count}
                      </span>
                    )}
                  </button>
                )
              }
              if (row.type === 'dh-item') {
                return renderAppChatItem(row.row, row.standalone)
              }
              return renderConversationItem(row.conversation)
            }}
        />
      </div>

      {/* Drag handle - on right side */}
      <div
        className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/50 transition-colors z-20 ${
          isDragging ? 'bg-primary/50' : ''
        }`}
        onMouseDown={handleMouseDown}
        title={t('Drag to resize width')}
      />
    </div>

    {hoverCardPortal}

    {/* Dropdown menu — Portal to document.body, fully outside flex layout.
        Pin lives inline on the row now; this keeps rename/delete. */}
    {menuOpenId && menuPosition && (() => {
      const conv = conversations.find(c => c.id === menuOpenId)
      if (conv) {
        return createPortal(
          <div
            ref={menuRef}
            className="fixed z-[9999] min-w-[140px] bg-popover border border-border rounded-lg shadow-lg py-1"
            style={{ top: menuPosition.top, left: menuPosition.left, transform: 'translateX(-100%)' }}
          >
            <button
              onClick={(e) => {
                handleStartEdit(e, conv)
                setMenuOpenId(null)
                setMenuPosition(null)
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              <span>{t('Rename')}</span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                const spaceId = useSpaceStore.getState().currentSpace?.id
                if (spaceId) useChatStore.getState().deleteConversation(spaceId, conv.id)
                setMenuOpenId(null)
                setMenuPosition(null)
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{t('Delete')}</span>
            </button>
          </div>,
          document.body
        )
      }

      // Digital-human row menu: delete only (rename is meaningless —
      // the title is always the digital-human's own name), with an inline
      // confirm step since it either clears history or drops a local session.
      const dhRow = allAppChatRows.find(r => r.id === menuOpenId)
      if (!dhRow) return null
      const confirming = pendingDeleteAppChatId === dhRow.id
      return createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] min-w-[160px] bg-popover border border-border rounded-lg shadow-lg py-1"
          style={{ top: menuPosition.top, left: menuPosition.left, transform: 'translateX(-100%)' }}
        >
          {confirming ? (
            <div className="px-3 py-2">
              <p className="text-xs text-muted-foreground mb-2">
                {dhRow.isDefault ? t('Clear all chat history?') : t('Delete this conversation?')}
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={(e) => { e.stopPropagation(); setPendingDeleteAppChatId(null) }}
                  className="px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary rounded transition-colors"
                >
                  {t('Cancel')}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); void handleDeleteAppChat(dhRow) }}
                  className="px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10 rounded transition-colors"
                >
                  {t('Confirm')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setEditingId(dhRow.id)
                  setEditingTitle(dhRow.customName || dhRow.displayName.trim() || '')
                  setMenuOpenId(null)
                  setMenuPosition(null)
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" />
                <span>{t('Rename')}</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setPendingDeleteAppChatId(dhRow.id) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{dhRow.isDefault ? t('Clear chat') : t('Delete')}</span>
              </button>
            </>
          )}
        </div>,
        document.body
      )
    })()}
    </>
  )
})
