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
  /** True when the author is fixed to the signed-in identity (um mode). */
  readOnly?: boolean
  /** Highlight red when a submit flagged this required field as empty. */
  invalid?: boolean
}

export function AuthorField({ value, onChange, readOnly, invalid }: AuthorFieldProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-muted-foreground">
        {t('Author')} <span className="text-red-400">*</span>
      </label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={t('Your name or handle')}
        readOnly={readOnly}
        className={`w-full px-3 py-1.5 text-[13px] bg-muted/40 border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50 ${invalid ? 'border-red-400 ring-1 ring-red-400/40' : 'border-border'} ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
      />
      <p className="text-[11px] text-muted-foreground/70">
        {readOnly
          ? t('From your signed-in account.')
          : t('Used as your namespace in the store (e.g. author/app-name).')}
      </p>
    </div>
  )
}
