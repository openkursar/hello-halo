/**
 * The quiet chevron beside "Add AI Provider" that leads to a new group; someone
 * who never needs a group sees nothing more.
 */

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { GroupIcon } from './group-parts'

export function GroupCreateMenu({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ariaLabel={t('More ways to add')}
        className="cursor-pointer items-center justify-center px-4 border-2 border-dashed border-border
                 hover:border-primary text-muted-foreground hover:text-primary rounded-lg transition-colors"
      >
        <ChevronDown size={16} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onCreate()
          }}
          className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-secondary"
        >
          <GroupIcon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block text-sm text-foreground">{t('Create Load-Balancing Group')}</span>
            <span className="block text-xs text-muted-foreground">{t('Switch between several models automatically')}</span>
          </span>
        </button>
      </PopoverContent>
    </Popover>
  )
}
