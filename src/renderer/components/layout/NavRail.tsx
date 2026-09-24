/**
 * NavRail - persistent global navigation column
 *
 * Left-most column (56px, 64px on macOS where it also hosts the window's
 * traffic lights) with the four primary destinations (conversation /
 * digital humans / knowledge base / store), plus tasks and settings pinned
 * to the bottom. Hidden only in a genuinely narrow layout (see
 * useIsNarrowShell) — HeaderShell's NarrowNavSheet is the escape hatch to
 * these same destinations there.
 *
 * The rail spans the window's full height, alongside both the Header row and
 * the content below it — matching the prototype's grid (sidebar as one full-
 * height column, header+body as the other). On macOS the traffic lights live
 * in this column too, in the spacer above the brand mark.
 */

import { useId } from 'react'
import { MessageSquare, Bot, BookOpen, Compass, SquareCheckBig, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import logoIconOnDark from '../../assets/brand/halo-logo-icon-on-dark.svg'
import logoIconOnLight from '../../assets/brand/halo-logo-icon-on-light.svg'
import { useAppStore } from '../../stores/app.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTaskPanelStore } from '../../stores/taskPanel.store'
import { useTaskCount, useTaskBeacon } from '../../stores/task.store'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import { useIsNarrowShell } from '../../hooks/useIsMobile'
import { useGoToConversation } from '../../hooks/useGoToConversation'
import { usePlatform } from './Header'
import { isElectron } from '../../api/transport'

type Destination = 'chat' | 'digital-humans' | 'knowledge' | 'store'

// Band the macOS traffic lights occupy, above the brand mark. Sized so the
// brand mark lines up with ConversationList's "New conversation" button
// (48px header + 16px top padding). Divided by
// --display-scale so it stays a constant number of real pixels under zoom,
// which is what trafficLightPosition is measured in.
const MAC_TRAFFIC_LIGHT_CLEARANCE_PX = 52

function useActiveDestination(): Destination | null {
  const view = useAppStore(s => s.view)

  if (view === 'space') return 'chat'
  if (view === 'tlon') return 'knowledge'
  if (view === 'apps') return 'digital-humans'
  if (view === 'store') return 'store'
  return null
}

interface NavItemProps {
  icon: LucideIcon
  label: string
  /** Hover tooltip text; falls back to `label` when omitted. */
  tip?: string
  active?: boolean
  /** Soft variant of `active` — weaker fill, used for the Tasks button's
   * "pending, but panel not open" state. Ignored when `active` is set. */
  attn?: boolean
  onClick?: () => void
  /** 44x44/rounded-lg instead of the default 40x40/rounded-md — the Tasks
   * button is a deliberate size step up (prototype: `.task-btn` vs
   * `.nav-item`), not a general size option. */
  size?: 'default' | 'lg'
  /** Count badge, bottom-right of the icon — shown only alongside `attn`
   * (matching the prototype's `.cta` visibility, gated on `.attn` alone). */
  badge?: number
  /** Small spinning ring, top-right of the icon — an in-progress indicator
   * (e.g. a task currently generating), independent of `badge`'s count. */
  spinning?: boolean
}

/**
 * Single rail button — a floating rounded icon block (not a full-width bar),
 * matching the prototype. Selected state is a soft fill + accent-tinted icon
 * on the block itself — the prototype's CSS also defines a left edge
 * indicator bar, but it's positioned outside the app's own bounds (`left:
 * -12px` inside an `overflow:hidden` root) and never actually renders, so
 * it's intentionally not reproduced here.
 * Hover uses a custom-styled tooltip instead of the native `title` so it
 * matches the app's popover styling instead of the OS default; it's a real
 * element (not a CSS pseudo-element) with `role="tooltip"` and wired via
 * `aria-describedby` so screen readers get it too.
 */
function NavItem({ icon: Icon, label, tip, active, attn, onClick, size = 'default', badge, spinning }: NavItemProps) {
  const tooltipId = useId()
  const isLg = size === 'lg'

  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      aria-describedby={tooltipId}
      className={cn(
        'group relative flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card',
        isLg ? 'w-11 h-11 rounded-lg' : 'w-10 h-10 rounded-md',
        active
          ? 'bg-primary/[0.18] text-accent-on-dark'
          : attn
            ? 'bg-primary/[0.12] text-accent-on-dark'
            : 'text-subtle-foreground hover:bg-secondary hover:text-foreground'
      )}
    >
      <Icon className="w-5 h-5" strokeWidth={1.8} />

      {spinning && (
        <span className="absolute top-[5px] right-[5px] w-[9px] h-[9px] rounded-full border-2 border-primary border-t-transparent animate-spin" />
      )}
      {!!badge && (
        <span className="absolute bottom-[3px] right-[3px] min-w-4 h-4 px-1 rounded-sm border-[1.5px] border-card bg-primary text-primary-foreground text-[10px] font-bold tabular-nums flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </span>
      )}

      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute left-full top-1/2 z-[60] ml-3 -translate-x-1 -translate-y-1/2 whitespace-nowrap rounded-[6px] border border-border bg-secondary px-2 py-1 text-xs text-foreground opacity-0 shadow-soft transition-[opacity,transform] duration ease-halo group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
      >
        {tip ?? label}
      </span>
    </button>
  )
}

export function NavRail() {
  const { t } = useTranslation()
  const view = useAppStore(s => s.view)
  const navigate = useAppStore(s => s.navigate)
  const active = useActiveDestination()
  const isNarrow = useIsNarrowShell()
  const taskCount = useTaskCount()
  const taskBeacon = useTaskBeacon()
  const toggleTaskPanel = useTaskPanelStore(s => s.toggle)
  const isTaskPanelOpen = useTaskPanelStore(s => s.isOpen)
  const platform = usePlatform()
  const isMacElectron = isElectron() && platform.isMac

  const goChat = useGoToConversation()
  const goDigitalHumans = () => {
    useAppsPageStore.getState().setCurrentTab('my-digital-humans')
    navigate('apps')
  }
  const goStore = () => navigate('store')
  const goKnowledge = () => navigate('tlon')
  const goSettings = () => navigate('settings')

  if (isNarrow) return null

  // Tooltip swaps to reflect task state.
  const taskLabel = t('Tasks')
  const taskTip = taskCount > 0
    ? t('Tasks · {{count}} pending', { count: taskCount })
    : taskBeacon === 'running'
      ? t('Tasks · Running')
      : taskLabel

  return (
    // pt-3/pb-3.5 (12px/14px) matches the prototype's `.sidebar{padding:12px
    // 0 14px}` — the brand mark sits right under that top padding, not below
    // a Header-height spacer.
    <div
      className={cn(
        'flex flex-col items-center h-full flex-shrink-0 bg-card border-r border-border pt-3 pb-3.5',
        !isMacElectron && 'w-14'
      )}
      // The macOS traffic-light group is wider than the prototype's 56px
      // column and doesn't zoom, so the rail keeps 64 real pixels at any
      // zoom, and never less than 64 CSS pixels for its own icons.
      style={isMacElectron ? { width: 'max(4rem, calc(64px / var(--display-scale, 1)))' } : undefined}
    >
      {isMacElectron && (
        <div
          className="w-full flex-shrink-0 drag-region"
          style={{ height: `calc(${MAC_TRAFFIC_LIGHT_CLEARANCE_PX}px / var(--display-scale, 1))` }}
        />
      )}
      {/* Brand logo icon — halo ring, 1:1 square. */}
      <div className="flex-shrink-0 mb-7 flex items-center justify-center px-1">
        <img src={logoIconOnDark} alt="Halo" className="brand-mark-dark w-8 h-8" />
        <img src={logoIconOnLight} alt="Halo" className="brand-mark-light w-8 h-8" />
      </div>

      <nav className="flex-1 w-full flex flex-col items-center gap-1.5">
        <NavItem icon={MessageSquare} label={t('Conversation')} active={active === 'chat'} onClick={goChat} />
        <NavItem
          icon={Bot}
          label={t('Digital Humans')}
          tip={t('Digital Humans · Extensions')}
          active={active === 'digital-humans'}
          onClick={goDigitalHumans}
        />
        <NavItem icon={BookOpen} label={t('Knowledge Base')} active={active === 'knowledge'} onClick={goKnowledge} />
        <NavItem
          icon={Compass}
          label={t('Store')}
          tip={t('Explore · Store')}
          active={active === 'store'}
          onClick={goStore}
        />
      </nav>

      <div className="w-full flex flex-col items-center gap-1.5">
        <NavItem
          icon={SquareCheckBig}
          label={taskLabel}
          tip={taskTip}
          size="lg"
          active={isTaskPanelOpen}
          attn={taskCount > 0}
          badge={taskCount}
          spinning={taskBeacon === 'running'}
          onClick={toggleTaskPanel}
        />
        <NavItem icon={Settings} label={t('Settings')} active={view === 'settings'} onClick={goSettings} />
      </div>
    </div>
  )
}
