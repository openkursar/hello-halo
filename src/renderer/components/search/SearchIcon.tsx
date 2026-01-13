/**
 * Search Icon Component
 *
 * Clickable search icon for the Header
 * Default behavior:
 * - On chat page: opens conversation-scoped search
 * - On space list: opens global search
 */

import { Search } from 'lucide-react'
import { SearchScope } from './SearchPanel'
import { useTranslation } from '../../i18n'

interface SearchIconProps {
  onClick: (scope: SearchScope) => void
  isInSpace?: boolean
}

export function SearchIcon({ onClick, isInSpace = false }: SearchIconProps) {
  const { t } = useTranslation()

  const handleClick = () => {
    // Default scope based on current context
    const scope: SearchScope = isInSpace ? 'space' : 'conversation'
    onClick(scope)
  }

  return (
    <button
      onClick={handleClick}
      className="p-1.5 text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-muted"
      title={t('Search (Cmd+K)')}
      aria-label={t('Search')}
    >
      <Search size={18} />
    </button>
  )
}
