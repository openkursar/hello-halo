/**
 * AuthorField
 *
 * Controlled author input shared by every share-to-store flow. The value
 * becomes the publisher's namespace in the store (e.g. `author/app-name`),
 * so it is required before publishing.
 *
 * Stateless on purpose — each dialog owns the value, its default, and
 * validation. This component only renders the labelled input + hint.
 */

import { useTranslation } from '../../i18n'

export interface AuthorFieldProps {
  value: string
  onChange: (value: string) => void
}

export function AuthorField({ value, onChange }: AuthorFieldProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-foreground">
        {t('Author')} <span className="text-red-400">*</span>
      </label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={t('Your name or handle')}
        className="w-full px-3 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
      />
      <p className="text-[11px] text-muted-foreground/70">
        {t('Used as your namespace in the store (e.g. author/app-name).')}
      </p>
    </div>
  )
}
