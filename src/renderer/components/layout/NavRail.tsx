/**
 * NavRail - persistent global navigation column
 *
 * Left-most 56px column with the four primary destinations (conversation /
 * digital humans / knowledge base / store) and tasks/settings pinned to the
 * bottom. Desktop only — narrow widths keep using the existing
 * MobileOverflowMenu, the same breakpoint every other layout component uses.
 *
 * The top spacer reserves the row height of the per-page Header so rail icons
 * line up with it, and doubles as the macOS traffic-light clearance.
 */

import type { ComponentType } from 'react'
import { MessageSquare, Bot, BookOpen, Store, ListChecks, Settings } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import { useSpaceStore } from '../../stores/space.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'

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
  disabled?: boolean
  onClick?: () => void
}

function NavItem({ icon: Icon, label, active, disabled, onClick }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'w-full h-11 flex items-center justify-center border-l-[3px] transition-colors',
        disabled
          ? 'border-transparent text-muted-foreground/40 cursor-not-allowed'
          : active
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground'
      )}
    >
      <Icon className="w-5 h-5" />
    </button>
  )
}

export function NavRail() {
  const { t } = useTranslation()
  const view = useAppStore(s => s.view)
  const setView = useAppStore(s => s.setView)
  const currentSpace = useSpaceStore(s => s.currentSpace)
  const active = useActiveDestination()

  const goChat = () => setView(currentSpace ? 'space' : 'home')
  const goDigitalHumans = () => {
    useAppsPageStore.getState().setCurrentTab('my-digital-humans')
    setView('apps')
  }
  const goStore = () => {
    useAppsPageStore.getState().setCurrentTab('store')
    setView('apps')
  }
  const goKnowledge = () => setView('tlon')
  const goSettings = () => setView('settings')

  return (
    <div className="hidden sm:flex flex-col items-center w-14 h-full flex-shrink-0 bg-card border-r border-border">
      {/* Aligns with the per-page Header row; also clears macOS traffic lights. */}
      <div className="w-full h-10 flex-shrink-0 drag-region" />

      <nav className="flex-1 w-full flex flex-col items-center gap-1 pt-2 no-drag">
        <NavItem icon={MessageSquare} label={t('Conversation')} active={active === 'chat'} onClick={goChat} />
        <NavItem icon={Bot} label={t('Digital Humans')} active={active === 'digital-humans'} onClick={goDigitalHumans} />
        <NavItem icon={BookOpen} label={t('Knowledge Base')} active={active === 'knowledge'} onClick={goKnowledge} />
        <NavItem icon={Store} label={t('Store')} active={active === 'store'} onClick={goStore} />
      </nav>

      <div className="w-full flex flex-col items-center gap-1 pb-3 no-drag">
        <NavItem icon={ListChecks} label={t('Tasks (coming soon)')} disabled />
        <NavItem icon={Settings} label={t('Settings')} active={view === 'settings'} onClick={goSettings} />
      </div>
    </div>
  )
}
