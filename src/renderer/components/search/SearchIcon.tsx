/**
 * Global search entry for the Header: an icon-only button in the right slot,
 * with its label and ⌘K hint shown in a hover tooltip.
 *
 * Default behavior:
 * - On chat page: opens conversation-scoped search
 * - On space list: opens global search
 */

import { Search } from 'lucide-react'
import { SearchScope } from './SearchPanel'
import { useTranslation } from '../../i18n'
import { usePlatform } from '../layout/Header'
import { Tooltip } from '../ui/Tooltip'

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
    <Tooltip label={t('Search')} shortcut={isMac ? '⌘K' : 'Ctrl K'} side="bottom" align="end" className="flex-shrink-0">
      <button
        onClick={handleClick}
        className="w-8 h-8 rounded-sm flex items-center justify-center text-faint-foreground hover:bg-secondary hover:text-foreground transition-colors ease-halo"
        aria-label={t('Search')}
      >
        <Search className="w-[17px] h-[17px]" strokeWidth={1.8} />
      </button>
    </Tooltip>
  )
}
