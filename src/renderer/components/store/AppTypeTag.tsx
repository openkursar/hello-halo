/**
 * AppTypeTag
 *
 * The store-wide type tag: text-only, borderless, tinted per app type. Used
 * everywhere an app's type is shown next to a title (cards, detail, rank board,
 * my publications, dependencies) so the type chip stays consistent — the app's
 * own icon already carries the type shape, so no icon is repeated here.
 *
 * Labels use string literals so i18next-parser can extract them.
 */

import type { AppType } from '../../../shared/apps/spec-types'
import { useTranslation } from '../../i18n'

/** Borderless tinted tone per type — mirrors the mockup's `.tag`. */
const TAG_TONE: Record<AppType, string> = {
  automation: 'bg-primary/10 text-primary',
  mcp: 'bg-app-mcp/10 text-app-mcp',
  skill: 'bg-app-skill/10 text-app-skill',
  extension: 'bg-amber-500/10 text-amber-500',
}

function useAppTypeLabel(type: AppType): string {
  const { t } = useTranslation()
  switch (type) {
    case 'automation': return t('Digital Human')
    case 'mcp': return t('MCP')
    case 'skill': return t('Skill')
    case 'extension': return t('Extension')
  }
}

export function AppTypeTag({ type }: { type: AppType }) {
  const label = useAppTypeLabel(type)
  return (
    <span className={`inline-flex flex-shrink-0 items-center whitespace-nowrap px-1.5 py-px rounded text-[10.5px] leading-4 font-medium ${TAG_TONE[type]}`}>
      {label}
    </span>
  )
}
