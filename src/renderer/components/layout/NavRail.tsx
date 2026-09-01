/**
 * NavRail - persistent global navigation column
 *
 * Left-most 56px column with the four primary destinations (conversation /
 * digital humans / knowledge base / store) and settings pinned to the
 * bottom. Desktop only — narrow widths keep using the existing
 * MobileOverflowMenu, the same breakpoint every other layout component uses.
 *
 * The top spacer reserves the row height of the per-page Header so rail icons
 * line up with it, and doubles as the macOS traffic-light clearance.
 */

import type { ComponentType, CSSProperties } from 'react'
import { MessageSquare, Bot, BookOpen, Store, Settings } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import { useSpaceStore } from '../../stores/space.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import { isElectron } from '../../api/transport'
import { usePlatform } from './Header'

type Destination = 'chat' | 'digital-humans' | 'knowledge' | 'store'

function useActiveDestination(): Destination | null {
  const view = useAppStore(s => s.view)
  const appsTab = useAppsPageStore(s => s.currentTab)

  if (view === 'space') return 'chat'
  if (view === 'tlon') return 'knowledge'
  if (view === 'apps') return appsTab === 'store' ? 'store' : 'digital-humans'
  return null
}

interface NavItemProps {
  icon: ComponentType<{ className?: string }>
  label: string
  active?: boolean
  onClick?: () => void
}

function NavItem({ icon: Icon, label, active, onClick }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'w-full h-11 flex items-center justify-center border-l-[3px] transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground'
      )}
    >
      <Icon className="w-5 h-5" />
    </button>
  )
}

// Traffic-light DIP clearance the rail must cover at 100% zoom. Provisional —
// the plan's own 52-56px cluster estimate plus the x:8 offset (main/index.ts)
// can land as far as ~64px; not verified on a real device yet, see commit log.
const MAC_CHROME_CLEARANCE_PX = 64

export function NavRail() {
  const { t } = useTranslation()
  const view = useAppStore(s => s.view)
  const navigate = useAppStore(s => s.navigate)
  const currentSpace = useSpaceStore(s => s.currentSpace)
  const active = useActiveDestination()
  const platform = usePlatform()

  const goChat = () => navigate(currentSpace ? 'space' : 'home')
  const goDigitalHumans = () => {
    useAppsPageStore.getState().setCurrentTab('my-digital-humans')
    navigate('apps')
  }
  const goStore = () => {
    useAppsPageStore.getState().setCurrentTab('store')
    navigate('apps')
  }
  const goKnowledge = () => navigate('tlon')
  const goSettings = () => navigate('settings')

  // trafficLightPosition is native window-chrome DIP, invariant under
  // webContents.setZoomFactor() (--display-scale). The rail's CSS width is
  // NOT invariant — it shrinks in real DIP terms as the user zooms out. This
  // floor keeps the rail's real-DIP width >= the clearance the lights need
  // regardless of zoom. At the default 100% zoom this evaluates to
  // MAC_CHROME_CLEARANCE_PX itself (64px, wider than the 56px w-14 base) —
  // every mac user sees a 64px rail until display-scale reaches ~1.14
  // (64/56), above which w-14 wins back and the rail settles at 56px.
  const chromeInset: CSSProperties = isElectron() && platform.isMac
    ? { minWidth: `calc(${MAC_CHROME_CLEARANCE_PX}px / var(--display-scale, 1))` }
    : {}

  return (
    <div
      style={chromeInset}
      className="hidden sm:flex flex-col items-center w-14 h-full flex-shrink-0 bg-card border-r border-border"
    >
      {/* Aligns with the per-page Header row; also clears macOS traffic lights. */}
      <div className="w-full h-10 flex-shrink-0 drag-region" />

      <nav className="flex-1 w-full flex flex-col items-center gap-1 pt-2 no-drag">
        <NavItem icon={MessageSquare} label={t('Conversation')} active={active === 'chat'} onClick={goChat} />
        <NavItem icon={Bot} label={t('Digital Humans')} active={active === 'digital-humans'} onClick={goDigitalHumans} />
        <NavItem icon={BookOpen} label={t('Knowledge Base')} active={active === 'knowledge'} onClick={goKnowledge} />
        <NavItem icon={Store} label={t('Store')} active={active === 'store'} onClick={goStore} />
      </nav>

      <div className="w-full flex flex-col items-center gap-1 pb-3 no-drag">
        <NavItem icon={Settings} label={t('Settings')} active={view === 'settings'} onClick={goSettings} />
      </div>
    </div>
  )
}
