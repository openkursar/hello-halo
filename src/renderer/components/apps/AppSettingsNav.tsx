/**
 * AppSettingsNav
 *
 * Quick-jump menu for the digital human's Settings panel, mirroring the global
 * Settings page pattern (nav + anchor scroll) so both settings surfaces behave
 * the same way.
 *
 * Items carry counts and an alert dot, which turns the menu into a small status
 * board: an unreachable MCP or an unsaved edit is visible without opening each
 * group in turn.
 *
 * Below the sm breakpoint the column becomes one horizontally scrolling strip
 * (the entries keep their width — a squeezed entry would ellipsize every label
 * into the same few characters), and the strip scrolls inside its own box so
 * the panel never widens the page.
 */

export interface SettingsNavItem {
  id: string
  label: string
  /** Short count/value shown after the label, e.g. "30m" or "5". */
  badge?: string
  /** Something in this group needs attention (offline dependency, empty required field). */
  alert?: boolean
  /** This group holds edits that have not been submitted yet. */
  dirty?: boolean
}

interface AppSettingsNavProps {
  items: SettingsNavItem[]
  activeId: string | null
  onSelect: (id: string) => void
}

export function AppSettingsNav({ items, activeId, onSelect }: AppSettingsNavProps) {
  return (
    <nav className="w-full sm:w-44 sm:flex-shrink-0 sm:sticky sm:top-4 sm:self-start">
      {/* `w-full` is load-bearing below the breakpoint: the panel stacks its
          children with `items-start`, which shrink-to-fits this nav to the
          strip's content width instead of the panel's. The strip would then
          push past the panel edge instead of scrolling inside it. */}
      <div className="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
        {items.map(item => {
          const active = item.id === activeId
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={`flex max-sm:flex-shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-1.5 text-xs text-left transition-colors rounded-md sm:rounded-r-md sm:rounded-l-none sm:border-l-2 ${
                active
                  ? 'bg-primary/[0.08] text-primary font-medium sm:border-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary sm:border-transparent'
              }`}
            >
              <span className="truncate">{item.label}</span>
              {item.alert && <span className="w-1.5 h-1.5 rounded-full bg-halo-warning flex-shrink-0" />}
              {item.dirty && <span className="w-1.5 h-1.5 rounded-full bg-halo-warning flex-shrink-0" />}
              {item.badge && (
                <span className={`ml-auto tabular-nums ${active ? 'text-primary/80' : 'text-muted-foreground/70'}`}>
                  {item.badge}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
