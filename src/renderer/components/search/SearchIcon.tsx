/**
 * Global search entry for the Header — prototype `.hsearch`: a bordered pill
 * with an icon, a "Search" label, and a ⌘K hint badge (not a bare icon
 * button). Lives in the Header's left slot, right after the space/page
 * identity, on every page — the prototype's `.hsearch` has no `chat-only`
 * class, so it's present in both chat and plain header modes.
 *
 * Default behavior:
 * - On chat page: opens conversation-scoped search
 * - On space list: opens global search
 */

import { Search } from 'lucide-react'
import { SearchScope } from './SearchPanel'
import { useTranslation } from '../../i18n'
import { usePlatform } from '../layout/Header'

interface SearchIconProps {
  onClick: (scope: SearchScope) => void
  isInSpace?: boolean
}

export function SearchIcon({ onClick, isInSpace = false }: SearchIconProps) {
  const { t } = useTranslation()
  const { isMac } = usePlatform()

  const handleClick = () => {
    // Default scope based on current context
    const scope: SearchScope = isInSpace ? 'space' : 'conversation'
    onClick(scope)
  }

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-[7px] h-8 px-[9px] rounded-sm border border-border bg-card text-subtle-foreground text-xs hover:border-primary transition-colors ease-halo flex-shrink-0"
      title={t('Search (Cmd+K)')}
      aria-label={t('Search')}
    >
      <Search className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="hidden sm:inline">{t('Search')}</span>
      <span className="hidden sm:inline text-[10px] border border-border rounded px-1 leading-[15px]">
        {isMac ? '⌘K' : 'Ctrl K'}
      </span>
    </button>
  )
}
