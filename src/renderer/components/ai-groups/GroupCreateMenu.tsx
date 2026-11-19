/**
 * The quiet chevron beside "Add AI Provider" that leads to a new group; someone
 * who never needs a group sees nothing more.
 */

import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, Workflow } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { GroupIcon } from './group-parts'

function MenuAction({ icon, title, description, onClick }: { icon: ReactNode; title: string; description: string; onClick: () => void }) {
  const id = useId()
  return (
    <button type="button" aria-labelledby={id} aria-describedby={`${id}-description`} onClick={onClick} className="flex min-h-11 w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-secondary">
      <span aria-hidden className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span id={id} className="block text-sm text-foreground">{title}</span>
        <span id={`${id}-description`} className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}

export function GroupCreateMenu({ onCreate, onConfigureModels }: { onCreate: () => void; onConfigureModels?: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div data-ai-add-menu className="flex">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          ariaLabel={t('More ways to add')}
          className="cursor-pointer items-center justify-center px-4 border-2 border-dashed border-border
                   hover:border-primary text-muted-foreground hover:text-primary rounded-lg transition-colors"
        >
          <ChevronDown size={16} />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-1">
          <MenuAction
            icon={<GroupIcon size={16} />}
            title={t('Create Load-Balancing Group')}
            description={t('Switch between several models automatically')}
            onClick={() => { setOpen(false); onCreate() }}
          />
          {onConfigureModels && (
            <MenuAction
              icon={<Workflow size={16} />}
              title={t('Configure model assignments')}
              description={t('Choose models for different tasks')}
              onClick={() => { setOpen(false); onConfigureModels() }}
            />
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
