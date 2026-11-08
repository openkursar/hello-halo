/** Pieces every group screen shares, so a group looks the same beside ordinary accounts. */

import { Layers } from 'lucide-react'
import { useTranslation } from '../../i18n'

/** The glyph for a group; deliberately not a vendor logo, since a group mixes several. */
export const GroupIcon = Layers

/** Marks a name as an automatic group rather than a single account. */
export function AutoTag({ className = '' }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <span className={`shrink-0 whitespace-nowrap rounded-sm bg-secondary px-1.5 text-[10px] font-medium leading-4 text-muted-foreground ${className}`}>
      {t('Auto')}
    </span>
  )
}

/** A model above the account it belongs to — the order every picker in the app uses. */
export function MemberName({ account, model, className = '' }: { account: string; model: string; className?: string }) {
  return (
    <span className={`flex min-w-0 flex-col ${className}`}>
      <span className="truncate text-sm text-foreground" title={model}>{model}</span>
      <span className="truncate text-xs text-muted-foreground" title={account}>{account}</span>
    </span>
  )
}
