/**
 * Conversation List - Resizable sidebar for multiple conversations
 * Self-contained: subscribes to its own data from stores, no data props from parent.
 * Supports drag-to-resize, inline title editing, and conversation management.
 */

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import { Virtuoso, type Components } from 'react-virtuoso'
import { Plus } from '../icons/ToolIcons'
import { EllipsisVertical, Pin, Pencil, Trash2, ChevronRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useChatStore, useAllConversationStatuses } from '../../stores/chat.store'
import { useSpaceStore } from '../../stores/space.store'
import { useAppStore } from '../../stores/app.store'
import { useAppChatPinsStore } from '../../stores/app-chat-pins.store'
import {
  useConversationListPrefs, isSectionOpen, type ConversationSection,
} from '../../stores/conversation-list-prefs.store'
import { ROW_HEIGHT, usePaneResize, PaneResizeHandle } from './conversation-list-panes'
import { api } from '../../api'
import { cn } from '../../lib/utils'
import { TaskStatusDot } from '../pulse/TaskStatusDot'
import { EngineBadge } from './EngineBadge'
import { AutomationAvatar } from '../apps/AutomationAvatar'
import { useAppChatConversationRows, type AppChatConversationRow } from '../../hooks/useAppChatConversationRows'
import { appChatSessionLabel, formatRowTime } from './conversation-row-format'
import { parseAppChatKey } from '../../../shared/apps/im-keys'
import { NATIVE_SESSION_CHANNEL, NATIVE_DEFAULT_CHAT_ID } from '../../../shared/types/im-channel'
import type { ConversationMeta, TaskStatus } from '../../types'
import { markEntry, trackHome, trackNavigate } from '../../services/home-telemetry'
import { openDigitalHumanChat } from '../../utils/conversation-navigation'
import { openPersonActivity } from '../../utils/people-navigation'

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
   * `.body.canvas-open .conv`). The resize handle can still drag it open. */
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

/** Flattened row fed to `Virtuoso` — a digital human's sub-header and its
 * sessions share one list instead of nested groups (see history:
 * `GroupedVirtuoso`'s separate groups API had a rendering bug where
 * header/item data could desync). */
type ConversationRow =
  | { type: 'item'; key: string; conversation: ConversationMeta }
  | { type: 'dh-header'; key: string; appId: string; name: string; uninstalled: boolean; collapsed: boolean }
  /** `standalone` rows sit outside their digital human's section (i.e. in
   *  Pinned), so they carry the avatar/name context the section header would
   *  otherwise provide. */
  | { type: 'dh-item'; key: string; row: AppChatConversationRow; standalone: boolean }

type PinnedRow = Extract<ConversationRow, { type: 'item' | 'dh-item' }>

/** Which status the folded digital-humans header shows when several sessions need attention. */
const ATTENTION_ORDER: TaskStatus[] = ['waiting', 'error', 'completed-unseen', 'generating']

const EMPTY_SECTION_CHOICES: Partial<Record<ConversationSection, boolean>> = {}
const EMPTY_GROUP_CHOICES: Record<string, boolean> = {}

/** The digital-humans section and groups the list opened on its own (not the user). */
interface AutoOpen {
  section: boolean
  apps: ReadonlySet<string>
}
const NO_AUTO_OPEN: AutoOpen = { section: false, apps: new Set() }

/**
 * The scroller takes no padding: Virtuoso's viewport is absolutely positioned
 * at top 0 and width 100% of the scroller's padding box, so side padding shifts
 * rows right without narrowing them (clipping their right edge) and vertical
 * padding is ignored. Side spacing lives on each row instead, and the top and
 * bottom spacing are Header/Footer spacers. `flow-root` keeps a header row's
 * top margin inside the row, where Virtuoso measures it.
 */
const PaddedRow: Components<ConversationRow>['Item'] = ({ children, item: _item, context: _context, ...props }) => (
  <div {...props} className="flow-root px-2 pb-0.5">{children}</div>
)
const listComponents: Components<ConversationRow> = {
  Item: PaddedRow,
  Header: () => <div className="h-1" />,
  Footer: () => <div className="h-3" />,
}

// Titles run to the row's edge and fade out instead of ending in an ellipsis;
// the hover actions float over that edge rather than reserving room for it.
const ROW_TITLE = 'flex-1 min-w-0 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%_-_20px),transparent)]'
// Shown only while the row itself is highlighted (hover, open menu, keyboard
// focus), since their fade-in backdrop is the row's highlight colour.
const ROW_ACTIONS = 'absolute inset-y-0 right-1.5 flex items-center gap-0.5 pl-5 bg-[linear-gradient(to_right,transparent,hsl(var(--secondary))_20px)] opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-data-[menu-open]:opacity-100 group-data-[menu-open]:pointer-events-auto has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto'
// `dark-ui:` rows outrank plain state variants, so the open-menu text is restated for dark.
const ROW_HIGHLIGHT = 'data-[menu-open]:bg-secondary data-[menu-open]:text-foreground dark-ui:data-[menu-open]:text-foreground has-[:focus-visible]:bg-secondary'

/**
 * A top-level section's fold toggle; its open-state arrow shows while the
 * pointer is anywhere in its own section (the `group/section` container).
 * No uppercase/letter-spacing: both are no-ops on CJK labels and only loosen them oddly.
 */
function SectionHeaderButton({ section, label, hint, collapsed, attention, onToggle }: {
  section: ConversationSection
  label: string
  /** Hover-only: the distinction between sections is one-time knowledge, not worth permanent space. */
  hint?: string
  collapsed: boolean
  /** Shown while folded, so a session needing the user isn't hidden with it. */
  attention?: TaskStatus
  onToggle: (section: ConversationSection) => void
}) {
  return (
    <button
      type="button"
      onClick={() => {
        trackHome('home.conversation.section', { section, action: collapsed ? 'expand' : 'collapse' })
        onToggle(section)
      }}
      aria-expanded={!collapsed}
      title={hint}
      className="group flex w-full items-center gap-1 rounded-sm px-1.5 pb-1 text-xs font-medium text-subtle-foreground/70 dark-ui:text-subtle-foreground hover:text-subtle-foreground dark-ui:hover:text-muted-foreground transition-colors ease-halo"
    >
      <span>{label}</span>
      {collapsed && attention && <TaskStatusDot status={attention} size="sm" />}
      <ChevronRight className={cn(
        'ml-auto w-3 h-3 shrink-0 transition-[transform,opacity]',
        collapsed ? 'opacity-100' : 'rotate-90 opacity-0 group-hover/section:opacity-100 group-focus-visible:opacity-100'
      )} />
    </button>
  )
}

/** A digital human's face, clickable through to its page (activity thread). */
function PersonAvatarLink({ appId, name, size, dimmed, disabled, className }: {
  appId: string
  name: string
  size: number
  /** Half strength unless this digital human's conversation is open. */
  dimmed: boolean
  disabled?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const face = <AutomationAvatar name={name} size={size} />
  if (disabled) {
    return <span className={cn('flex shrink-0', dimmed && 'opacity-50 dark-ui:opacity-70', className)}>{face}</span>
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        trackNavigate('apps', 'conversation_list', 'home_conv_dh')
        openPersonActivity(appId)
      }}
      title={t('View {{name}}', { name })}
      aria-label={t('View {{name}}', { name })}
      className={cn(
        'flex shrink-0 rounded-full transition-[opacity,transform] ease-halo hover:opacity-100 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        dimmed && 'opacity-50 dark-ui:opacity-70 dark-ui:hover:opacity-100',
        className
      )}
    >
      {face}
    </button>
  )
}

/**
 * Pinned rows, regular and digital-human mixed in one recency order so
 * neither kind pushes the other out of view. Rendered in their own fixed area
 * above the scrolling list.
 */
function buildPinnedRows(conversations: ConversationMeta[], appChatRows: AppChatConversationRow[]): PinnedRow[] {
  return [
    ...conversations.filter(conv => conv.starred)
      .map(conv => ({ at: Date.parse(conv.updatedAt) || 0, row: { type: 'item' as const, key: conv.id, conversation: conv } })),
    ...appChatRows.filter(row => row.starred)
      .map(row => ({ at: row.updatedAt, row: { type: 'dh-item' as const, key: row.id, row, standalone: true } })),
  ].sort((a, b) => b.at - a.at).map(entry => entry.row)
}

/** Unpinned digital-human sessions under a collapsible sub-header per digital human. */
function buildDigitalHumanRows(
  appChatRows: AppChatConversationRow[],
  isAppGroupOpen: (appId: string, rows: AppChatConversationRow[]) => boolean,
): ConversationRow[] {
  const byApp = new Map<string, AppChatConversationRow[]>()
  for (const row of appChatRows) {
    if (row.starred) continue
    const list = byApp.get(row.appId) ?? []
    list.push(row)
    byApp.set(row.appId, list)
  }

  const out: ConversationRow[] = []
  for (const [appId, rows] of byApp) {
    const collapsed = !isAppGroupOpen(appId, rows)
    out.push({
      type: 'dh-header',
      key: `dh-header:${appId}`,
      appId,
      name: rows[0].digitalHumanName,
      uninstalled: rows[0].uninstalled,
      collapsed,
    })
    if (!collapsed) {
      for (const row of rows) out.push({ type: 'dh-item', key: row.id, row, standalone: false })
    }
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

  const spaceKey = currentSpaceId ?? ''
  const sectionChoices = useConversationListPrefs(s => s.sectionOpen[spaceKey]) ?? EMPTY_SECTION_CHOICES
  const appGroupChoices = useConversationListPrefs(s => s.appGroupOpen[spaceKey]) ?? EMPTY_GROUP_CHOICES
  const setAppGroupOpen = useConversationListPrefs(s => s.setAppGroupOpen)
  const setSectionOpen = useConversationListPrefs(s => s.setSectionOpen)
  // Single batch subscription for all conversation statuses (replaces N individual hooks)
  const conversationStatuses = useAllConversationStatuses()

  // What the list opens on its own, kept in memory only: the stored prefs hold
  // nothing but the user's own clicks. `section` and `apps` override a stored
  // fold until the user toggles that section or group again.
  const [autoOpen, setAutoOpen] = useState<AutoOpen & { space: string }>(() => ({ space: spaceKey, ...NO_AUTO_OPEN }))
  const auto: AutoOpen = autoOpen.space === spaceKey ? autoOpen : NO_AUTO_OPEN
  const updateAutoOpen = useCallback((change: (prev: AutoOpen) => AutoOpen) => {
    setAutoOpen(prev => {
      const base = prev.space === spaceKey ? prev : { space: spaceKey, ...NO_AUTO_OPEN }
      const next = change(base)
      return next.section === base.section && next.apps === base.apps ? base : { space: spaceKey, ...next }
    })
  }, [spaceKey])

  const pinnedOpen = isSectionOpen(sectionChoices, 'pinned')
  const digitalHumansOpen = auto.section || isSectionOpen(sectionChoices, 'digital-humans')
  const conversationsOpen = isSectionOpen(sectionChoices, 'conversations')
  const toggleSection = useCallback((section: ConversationSection) => {
    const open = section === 'digital-humans'
      ? auto.section || isSectionOpen(sectionChoices, section)
      : isSectionOpen(sectionChoices, section)
    if (section === 'digital-humans') updateAutoOpen(prev => (prev.section ? { ...prev, section: false } : prev))
    setSectionOpen(spaceKey, section, !open)
  }, [setSectionOpen, spaceKey, sectionChoices, auto.section, updateAutoOpen])

  // A digital human's group starts closed and opens on its own when it holds the
  // open conversation or a session needs attention; that stays until the user folds it.
  const selectedAppId = selectedAppChat?.appId
  const isAppGroupOpen = useCallback((appId: string, groupRows: AppChatConversationRow[]) => {
    if (auto.apps.has(appId)) return true
    const choice = appGroupChoices[appId]
    if (choice !== undefined) return choice
    return appId === selectedAppId || groupRows.some(row => conversationStatuses.has(row.id))
  }, [auto.apps, appGroupChoices, selectedAppId, conversationStatuses])
  const toggleAppCollapsed = useCallback((appId: string, open: boolean) => {
    updateAutoOpen(prev => {
      if (!prev.apps.has(appId)) return prev
      const apps = new Set(prev.apps)
      apps.delete(appId)
      return { ...prev, apps }
    })
    setAppGroupOpen(spaceKey, appId, !open)
  }, [setAppGroupOpen, spaceKey, updateAutoOpen])
  // Opening a conversation (from here or e.g. the task panel) shows its section
  // and group even if the user had folded them; pinned sessions already show.
  const selectedAppChatId = selectedAppChat?.conversationId
  const selectedAppChatPinned = !!selectedAppChatId && allAppChatRows.some(row => row.id === selectedAppChatId && row.starred)
  useEffect(() => {
    if (!selectedAppId || !selectedAppChatId || selectedAppChatPinned) return
    updateAutoOpen(prev => (prev.section && prev.apps.has(selectedAppId)
      ? prev
      : { section: true, apps: new Set(prev.apps).add(selectedAppId) }))
  }, [selectedAppId, selectedAppChatId, selectedAppChatPinned, updateAutoOpen])
  // A group that needs attention stays open after the session settles, unless the user folded it.
  useEffect(() => {
    const waiting = allAppChatRows.filter(row =>
      !row.starred && conversationStatuses.has(row.id) && appGroupChoices[row.appId] === undefined)
    if (waiting.length === 0) return
    updateAutoOpen(prev => {
      if (waiting.every(row => prev.apps.has(row.appId))) return prev
      const apps = new Set(prev.apps)
      for (const row of waiting) apps.add(row.appId)
      return { ...prev, apps }
    })
  }, [allAppChatRows, conversationStatuses, appGroupChoices, updateAutoOpen])

  // Width state - initialized from persisted config
  const initialWidth = layoutConfig?.sidebarWidth
  const [width, setWidth] = useState(initialWidth != null ? clampWidth(initialWidth) : DEFAULT_WIDTH)
  const [isDragging, setIsDragging] = useState(false)
  // Drag-triggered version of the canvas-open `collapsed` prop — lets the
  // user reach the same icon-strip view by dragging the handle instead of
  // only via the canvas. Independent of `collapsed`; combined below.
  const [isDragCollapsed, setIsDragCollapsed] = useState(false)
  // Dragged back open while the canvas has it collapsed. Lasts until the
  // canvas closes, so the next canvas open starts collapsed again.
  const [expandedOverCanvas, setExpandedOverCanvas] = useState(false)
  useEffect(() => { if (!collapsed) setExpandedOverCanvas(false) }, [collapsed])
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
  // Centred on its row, but shifted to stay inside the window — rows near the
  // bottom (or top) edge would otherwise cut the card off.
  const hoverCardRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = hoverCardRef.current
    if (!el || !hoverCard) return
    const margin = 8
    const h = el.offsetHeight
    const top = Math.min(Math.max(hoverCard.top - h / 2, margin), window.innerHeight - h - margin)
    el.style.top = `${top}px`
  }, [hoverCard])

  const pinnedRows = useMemo(() => buildPinnedRows(conversations, allAppChatRows), [conversations, allAppChatRows])
  const digitalHumanRows = useMemo(() => buildDigitalHumanRows(allAppChatRows, isAppGroupOpen), [allAppChatRows, isAppGroupOpen])
  const conversationRows = useMemo<ConversationRow[]>(
    () => conversations.filter(conv => !conv.starred).map(conv => ({ type: 'item', key: conv.id, conversation: conv })),
    [conversations]
  )
  // The icon strip has no headers to unfold, so a session needing the user shows there even when folded.
  const stripDigitalHumanRows = useMemo(() => {
    const listed = new Set(digitalHumansOpen ? digitalHumanRows.map(row => row.key) : [])
    return buildDigitalHumanRows(allAppChatRows, () => true)
      .filter(row => row.type === 'dh-item' && (listed.has(row.key) || conversationStatuses.has(row.key)))
  }, [allAppChatRows, digitalHumanRows, digitalHumansOpen, conversationStatuses])
  // Its most urgent session status, for the folded digital-humans header.
  const digitalHumanAttention = useMemo(() => {
    const statuses = new Set(allAppChatRows.filter(row => !row.starred).map(row => conversationStatuses.get(row.id)))
    return ATTENTION_ORDER.find(status => statuses.has(status))
  }, [allAppChatRows, conversationStatuses])

  // ── Panes: pinned and digital humans have their own height; conversations take the rest ──
  const listColumnRef = useRef<HTMLDivElement>(null)
  const pinnedScrollRef = useRef<HTMLDivElement>(null)
  const pinnedResize = usePaneResize('pinned', pinnedScrollRef, listColumnRef, () => pinnedScrollRef.current?.scrollHeight ?? 0)

  const digitalHumanPaneRef = useRef<HTMLDivElement>(null)
  // Virtuoso doesn't size itself to its rows, so the pane is held at the smaller of
  // the rows' total height and the pane height.
  const [digitalHumanListHeight, setDigitalHumanListHeight] = useState(0)
  const digitalHumanResize = usePaneResize('digital-humans', digitalHumanPaneRef, listColumnRef, () => digitalHumanListHeight)
  // With the conversations pane folded or empty there is nothing to leave room for.
  const digitalHumansFill = !conversationsOpen || conversationRows.length === 0

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
        if (collapsed) setExpandedOverCanvas(false)
        else setIsDragCollapsed(true)
        return
      }
      setIsDragCollapsed(false)
      if (collapsed) setExpandedOverCanvas(true)
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
  }, [isDragging, collapsed])

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
      trackHome('home.conversation.action', { action: 'rename', kind: appChatRow ? 'digital_human' : 'normal' })
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

  const handleSelectConversation = (conv: ConversationMeta) => {
    trackHome('home.conversation.select', { kind: 'normal', pinned: !!conv.starred })
    useChatStore.getState().selectConversation(conv.id)
  }

  const handleCreateConversation = (surface: 'list' | 'rail_collapsed') => {
    const spaceId = useSpaceStore.getState().currentSpace?.id
    if (!spaceId) return
    trackHome('home.conversation.create', { surface })
    useChatStore.getState().createConversation(spaceId)
  }

  const handleTogglePin = (e: React.MouseEvent, conv: ConversationMeta) => {
    e.stopPropagation()
    trackHome('home.conversation.action', { action: conv.starred ? 'unpin' : 'pin', kind: 'normal' })
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
    trackHome('home.conversation.select', { kind: 'digital_human', pinned: row.starred, appId: row.appId })
    markEntry('home_conv_dh')
    useChatStore.getState().selectAppChatConversation(spaceId, row.appId, row.id)
  }

  const handleNewAppChat = (appId: string) => {
    const spaceId = useSpaceStore.getState().currentSpace?.id
    if (!spaceId) return
    trackHome('home.conversation.create', { surface: 'dh_group' })
    // Starting one under a collapsed group should still show it.
    setAppGroupOpen(spaceId, appId, true)
    void openDigitalHumanChat(appId, spaceId)
  }

  const handleToggleAppChatPin = (e: React.MouseEvent, row: AppChatConversationRow) => {
    e.stopPropagation()
    trackHome('home.conversation.action', { action: row.starred ? 'unpin' : 'pin', kind: 'digital_human' })
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
    trackHome('home.conversation.action', { action: 'delete', kind: 'digital_human' })
    try {
      // The store owns what it holds for the conversation (cache, live turn,
      // selection), so it performs the deletion rather than only being told.
      const chat = useChatStore.getState()
      if (row.isDefault) await chat.clearConversation(row.id)
      else await chat.deleteAppChatSession(row.appId, spaceId, row.id)
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
        onClick={() => !isEditing && handleSelectConversation(conversation)}
        onMouseEnter={(e) => showHoverCard(e.currentTarget, hoverCardFor({ type: 'item', key: conversation.id, conversation }, t))}
        onMouseLeave={hideHoverCard}
        data-menu-open={menuOpenId === conversation.id || undefined}
        className={cn(
          'group relative flex w-full items-center gap-1.5 rounded-sm pl-2.5 pr-1.5 py-1.5 text-[13px] transition-colors ease-halo cursor-pointer',
          ROW_HIGHLIGHT,
          isActive
            ? 'bg-secondary text-foreground font-medium'
            // Rows are read, not just scanned: darker than the section labels in
            // light, the brighter secondary tone in dark; the selected one is marked by its fill.
            : 'text-foreground/80 hover:bg-secondary hover:text-foreground dark-ui:text-muted-foreground dark-ui:hover:text-foreground'
        )}
      >

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

            <span className={ROW_TITLE}>{conversation.title}</span>

            <EngineBadge engineId={conversation.engineId} size="xs" />

            <div className={ROW_ACTIONS}>
              <button
                onClick={(e) => handleTogglePin(e, conversation)}
                className={cn(
                  'w-[22px] h-[22px] flex-shrink-0 rounded-[6px] flex items-center justify-center transition-colors',
                  conversation.starred
                    ? 'text-accent-on-dark'
                    : 'text-faint-foreground hover:bg-surface-hover hover:text-foreground'
                )}
                title={conversation.starred ? t('Unpin') : t('Pin')}
                aria-pressed={conversation.starred}
              >
                <Pin className="w-[13px] h-[13px]" strokeWidth={1.8} />
              </button>

              <button
                onClick={(e) => openMoreMenu(e, conversation.id)}
                className="w-[22px] h-[22px] flex-shrink-0 rounded-[6px] flex items-center justify-center text-faint-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                title={t('More')}
              >
                <EllipsisVertical className="w-[13px] h-[13px]" strokeWidth={1.8} />
              </button>
            </div>
          </>
        )}
      </div>
    )
  }, [editingId, editingTitle, currentConversationId, selectedAppChat, conversationStatuses, menuOpenId, t])

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
        data-menu-open={menuOpenId === row.id || undefined}
        className={cn(
          'group relative flex w-full items-center gap-1.5 rounded-sm pr-1.5 py-1.5 text-[13px] transition-colors ease-halo',
          ROW_HIGHLIGHT,
          standalone ? 'pl-2.5' : 'pl-[30px]',
          row.uninstalled
            ? 'opacity-40 cursor-not-allowed'
            : 'cursor-pointer',
          isActive && !row.uninstalled
            ? 'bg-secondary text-foreground font-medium'
            // Rows are read, not just scanned: darker than the section labels in
            // light, the brighter secondary tone in dark; the selected one is marked by its fill.
            : 'text-foreground/80 hover:bg-secondary hover:text-foreground dark-ui:text-muted-foreground dark-ui:hover:text-foreground'
        )}
      >

        {standalone && (
          <PersonAvatarLink
            appId={row.appId}
            name={row.digitalHumanName}
            size={16}
            dimmed={!isActive}
            disabled={row.uninstalled}
          />
        )}

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
          <span className={ROW_TITLE}>
            {standalone && row.isDefault ? row.digitalHumanName : sessionLabel}
          </span>
        )}
        {row.status === 'paused' && !isEditing && (
          <span className="text-[11px] text-muted-foreground shrink-0">{t('Paused')}</span>
        )}

        {!row.uninstalled && (
          <div className={ROW_ACTIONS}>
            <button
              onClick={(e) => handleToggleAppChatPin(e, row)}
              className={cn(
                'w-[22px] h-[22px] flex-shrink-0 rounded-[6px] flex items-center justify-center transition-colors',
                row.starred
                  ? 'text-accent-on-dark'
                  : 'text-faint-foreground hover:bg-surface-hover hover:text-foreground'
              )}
              title={row.starred ? t('Unpin') : t('Pin')}
              aria-pressed={row.starred}
            >
              <Pin className="w-[13px] h-[13px]" strokeWidth={1.8} />
            </button>

            <button
              onClick={(e) => openMoreMenu(e, row.id)}
              className="w-[22px] h-[22px] flex-shrink-0 rounded-[6px] flex items-center justify-center text-faint-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
              title={t('More')}
            >
              <EllipsisVertical className="w-[13px] h-[13px]" strokeWidth={1.8} />
            </button>
          </div>
        )}
      </div>
    )
  }, [selectedAppChat?.conversationId, editingId, editingTitle, conversationStatuses, menuOpenId, t])

  // Fixed-positioned and portaled: the row lists scroll, and a scroll
  // container clips anything reaching past its edge.
  const hoverCardPortal = hoverCard && !editingId && !menuOpenId && createPortal(
    <div
      ref={hoverCardRef}
      role="tooltip"
      style={{ top: hoverCard.top, left: hoverCard.left }}
      className="pointer-events-none fixed z-[60] w-[260px] rounded-lg border border-border bg-popover px-3.5 py-3 shadow-lg"
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

  const renderDigitalHumanHeader = (row: Extract<ConversationRow, { type: 'dh-header' }>) => {
    const toggle = () => {
      trackHome('home.dh_group.toggle', { collapsed: !row.collapsed })
      toggleAppCollapsed(row.appId, !row.collapsed)
    }
    return (
      <div className={cn(
        'group flex w-full items-center gap-0.5 rounded-sm pr-1 mt-0.5 transition-colors ease-halo',
        row.uninstalled ? 'opacity-40' : 'hover:bg-secondary'
      )}>
        <PersonAvatarLink
          appId={row.appId}
          name={row.name}
          size={18}
          dimmed={selectedAppChat?.appId !== row.appId}
          disabled={row.uninstalled}
          className="ml-1.5"
        />
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!row.collapsed}
          className={cn(
            'flex flex-1 min-w-0 items-center pl-1.5 py-1.5 text-[13px] font-medium',
            // A group label, not a row to read: in the dark theme it sits with its sessions' tone.
            row.uninstalled ? 'cursor-not-allowed' : 'text-foreground dark-ui:text-muted-foreground'
          )}
        >
          <span className="flex-1 min-w-0 truncate text-left">{row.name}</span>
        </button>
        {!row.uninstalled && (
          <button
            type="button"
            onClick={() => handleNewAppChat(row.appId)}
            title={t('New conversation with {{name}}', { name: row.name })}
            aria-label={t('New conversation with {{name}}', { name: row.name })}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-subtle-foreground pointer-events-none opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
        {/* A second hit area for the same toggle; the name button carries it for keyboard users. */}
        <button type="button" tabIndex={-1} aria-hidden="true" onClick={toggle} className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ChevronRight className={cn(
            'w-3 h-3 text-subtle-foreground transition-[transform,opacity]',
            row.collapsed ? 'opacity-100' : 'rotate-90 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          )} />
        </button>
      </div>
    )
  }

  const renderListRow = (row: ConversationRow) => {
    if (row.type === 'dh-header') return renderDigitalHumanHeader(row)
    if (row.type === 'dh-item') return renderAppChatItem(row.row, row.standalone)
    return renderConversationItem(row.conversation)
  }

  if ((collapsed && !expandedOverCanvas) || isDragCollapsed) {
    return (
      <div
        ref={containerRef}
        className="relative w-14 h-full flex-shrink-0 border-r border-border-faint bg-background flex flex-col items-center"
      >
        <div className="w-full px-2 pt-2.5 pb-1.5">
          <button
            onClick={() => handleCreateConversation('rail_collapsed')}
            className="flex h-9 w-full items-center justify-center rounded-sm bg-secondary/60 text-foreground transition-colors ease-halo hover:bg-surface-hover"
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
        <div className="flex-1 w-full overflow-y-auto px-2 py-1 flex flex-col items-center gap-0.5">
          {[
            ...(pinnedOpen ? pinnedRows : []),
            ...stripDigitalHumanRows,
            ...(conversationsOpen ? conversationRows : []),
          ].map(row => {
            if (row.type === 'dh-header') return null
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
                    handleSelectConversation(row.conversation)
                  }
                }}
                onMouseEnter={(e) => showHoverCard(e.currentTarget, hoverCardFor(row, t))}
                onMouseLeave={hideHoverCard}
                aria-current={active}
                className={cn(
                  'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full transition-colors ease-halo hover:bg-secondary',
                  active && 'bg-secondary'
                )}
              >
                {/* Colour carries the state; the round backdrop marks the open
                    conversation (and hover) — with the list collapsed this is
                    the only place either is visible. */}
                {status !== 'idle' ? (
                  <TaskStatusDot status={status} size="md" />
                ) : (
                  <span className={cn(
                    'w-[7px] h-[7px] rounded-full',
                    active ? 'bg-foreground' : 'bg-subtle-foreground opacity-50'
                  )} />
                )}
              </button>
            )
          })}
        </div>
        {hoverCardPortal}
        <div
          className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/50 transition-colors z-20 ${
            isDragging ? 'bg-primary/50' : ''
          }`}
          onMouseDown={handleMouseDown}
          title={t('Drag to resize width')}
        />
      </div>
    )
  }

  return (
    <>
    <div
      ref={containerRef}
      className="border-r border-border-faint flex flex-col bg-background relative"
      style={{ width, transition: isDragging ? 'none' : 'width 0.2s ease' }}
    >
      <div className="flex flex-col gap-2 px-2.5 pt-4 pb-3">
        <button
          onClick={() => handleCreateConversation('list')}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-sm bg-secondary/60 text-xs font-medium text-foreground transition-colors ease-halo hover:bg-surface-hover"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('New conversation')}
        </button>
      </div>

      <div ref={listColumnRef} className="flex-1 min-h-0 flex flex-col">
      {pinnedRows.length > 0 && (
        // Shrinkable like the digital-humans pane, so a saved height never pushes the panes below off a shorter window.
        <div className="group/section relative flex min-h-0 flex-col pb-2">
          <div className="flex-shrink-0 px-2 pt-1">
            <SectionHeaderButton section="pinned" label={t('Pinned')} collapsed={!pinnedOpen} onToggle={toggleSection} />
          </div>
          {pinnedOpen && (
            <div ref={pinnedScrollRef} className="min-h-8 overflow-y-auto overflow-x-hidden" style={{ maxHeight: pinnedResize.height }}>
              {pinnedRows.map(row => (
                <div key={row.key} className="px-2 pb-0.5">
                  {row.type === 'dh-item' ? renderAppChatItem(row.row, row.standalone) : renderConversationItem(row.conversation)}
                </div>
              ))}
            </div>
          )}
          {pinnedOpen && (
            <PaneResizeHandle label={t('Resize pinned list')} height={pinnedResize.height} dragging={pinnedResize.dragging} handleProps={pinnedResize.handleProps} />
          )}
        </div>
      )}

      {digitalHumanRows.length > 0 && (
        <div
          data-fill-pane={digitalHumansOpen && digitalHumansFill ? '' : undefined}
          className={cn(
            'group/section relative flex flex-col pb-1',
            pinnedRows.length > 0 && 'border-t border-border-faint',
            // Otherwise shrinkable, so a short window squeezes this pane rather than overflowing the sidebar.
            digitalHumansOpen && digitalHumansFill ? 'flex-1 min-h-[68px]' : 'min-h-0'
          )}
        >
          <div className={cn('flex-shrink-0 px-2', pinnedRows.length > 0 ? 'pt-2.5' : 'pt-1')}>
            <SectionHeaderButton
              section="digital-humans"
              label={t('Digital Humans')}
              hint={t('Conversations with digital humans available in this workspace')}
              collapsed={!digitalHumansOpen}
              attention={digitalHumanAttention}
              onToggle={toggleSection}
            />
          </div>
          {digitalHumansOpen && (
            <div
              ref={digitalHumanPaneRef}
              className={digitalHumansFill ? 'flex-1 min-h-0' : 'min-h-8'}
              style={digitalHumansFill ? undefined : {
                flex: `0 1 ${Math.min(digitalHumanResize.height, digitalHumanListHeight || digitalHumanRows.length * ROW_HEIGHT)}px`,
              }}
            >
              <Virtuoso
                data={digitalHumanRows}
                overscan={200}
                totalListHeightChanged={setDigitalHumanListHeight}
                style={{ height: '100%' }}
                className="overflow-x-hidden"
                components={listComponents}
                itemContent={(_, row) => renderListRow(row)}
              />
            </div>
          )}
          {digitalHumansOpen && !digitalHumansFill && (
            <PaneResizeHandle
              label={t('Resize digital humans list')}
              height={digitalHumanResize.height}
              dragging={digitalHumanResize.dragging}
              handleProps={digitalHumanResize.handleProps}
            />
          )}
        </div>
      )}

      {conversationRows.length > 0 && (
        <div
          data-fill-pane={conversationsOpen ? '' : undefined}
          className={cn(
            'group/section flex flex-col',
            (pinnedRows.length > 0 || digitalHumanRows.length > 0) && 'border-t border-border-faint',
            // Open, it keeps its header and one row however the panes above are sized; folded, it is the
            // sidebar's last line and gets the same bottom room the list's footer gives rows.
            conversationsOpen ? 'flex-1 min-h-[68px]' : 'flex-shrink-0 pb-3'
          )}
        >
          <div className={cn('flex-shrink-0 px-2', pinnedRows.length > 0 || digitalHumanRows.length > 0 ? 'pt-2.5' : 'pt-1')}>
            <SectionHeaderButton
              section="conversations"
              label={t('Conversations')}
              hint={t('Your direct conversations with Halo')}
              collapsed={!conversationsOpen}
              onToggle={toggleSection}
            />
          </div>
          {/* Virtualized for performance with large lists */}
          {conversationsOpen && (
            <div className="flex-1 min-h-0">
              <Virtuoso
                data={conversationRows}
                overscan={200}
                style={{ height: '100%' }}
                // Virtuoso's scroller only sets overflow-y, which leaves overflow-x
                // resolving to `auto` — a stray pixel of row width then shows a
                // horizontal scrollbar under a list that never scrolls sideways.
                className="overflow-x-hidden"
                components={listComponents}
                itemContent={(_, row) => renderListRow(row)}
              />
            </div>
          )}
        </div>
      )}
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
                trackHome('home.conversation.action', { action: 'delete', kind: 'normal' })
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
