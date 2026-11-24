import type { ReactNode } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { cn } from '../../lib/utils'

export function ConversationGroupHeader({ avatar, name, collapsed, onToggle, onNew, newLabel, disabled = false, status }: {
  avatar: ReactNode
  name: string
  collapsed: boolean
  onToggle: () => void
  onNew?: () => void
  newLabel: string
  disabled?: boolean
  status?: ReactNode
}) {
  return <div className={cn('group flex w-full items-center gap-0.5 rounded-sm pl-2.5 pr-1 mt-0.5 transition-colors ease-halo', disabled ? 'opacity-40' : 'hover:bg-secondary')}>
    <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-start">{avatar}</span>
    <button type="button" aria-expanded={!collapsed} onClick={onToggle} className={cn('flex flex-1 min-w-0 items-center pl-1.5 py-1.5 text-[13px] font-medium', disabled ? 'cursor-not-allowed' : 'text-foreground/80 theme-dark:text-muted-foreground')}>
      <span className="min-w-0 truncate">{name}</span>{status}
    </button>
    {onNew && !disabled && <button type="button" onClick={onNew} title={newLabel} aria-label={newLabel} className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-subtle-foreground pointer-events-none opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"><Plus className="h-3.5 w-3.5" /></button>}
    <button type="button" tabIndex={-1} aria-hidden="true" onClick={onToggle} className="flex h-5 w-5 shrink-0 items-center justify-center"><ChevronRight className={cn('w-3 h-3 text-subtle-foreground transition-[transform,opacity]', collapsed ? 'opacity-100' : 'rotate-90 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')} /></button>
  </div>
}
