/**
 * ByokEntry — inline "bring your own key" entry on the login screen.
 *
 * Renders below the managed-login cards as the figure's "或使用自定义 API" block:
 * a single API Key input plus a Continue button. It is the inline presentation
 * of the product.json `custom` auth entry — a sibling to the navigate-on-click
 * card, dispatched by `LoginSelector` based on the entry's presentation kind.
 *
 * It intentionally does no validation: the key is carried forward to the full
 * provider config form (`SetupProviderConfig`), where the user picks a provider
 * and the connection can actually be tested.
 */

import { useState } from 'react'
import { Eye, EyeOff, ExternalLink } from 'lucide-react'
import { Lightbulb } from '../icons/ToolIcons'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { api } from '../../api'
import { resolveLocalizedText, type LocalizedText, type AuthProviderConfig } from '../../../shared/types'

interface ByokEntryProps {
  /** The product.json `custom` entry (provides label / docs link). */
  entry: AuthProviderConfig
  /** Advance to the full config step, carrying the typed key. */
  onContinue: (apiKey: string) => void
}

export function ByokEntry({ entry, onContinue }: ByokEntryProps) {
  const { t } = useTranslation()
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)

  const label = resolveLocalizedText(entry.displayName, getCurrentLanguage())

  return (
    <div className="pt-2">
      {/* Divider */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {t('Or use ${label}').replace('${label}', label)}
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* API Key input */}
      <label className="block text-sm text-muted-foreground mb-2">API Key</label>
      <div className="relative">
        <input
          type={showApiKey ? 'text' : 'password'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && apiKey.trim()) onContinue(apiKey.trim())
          }}
          placeholder={t('Enter your API Key')}
          className="w-full px-4 py-2.5 pr-12 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
        />
        <button
          type="button"
          onClick={() => setShowApiKey(!showApiKey)}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
        >
          {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>

      {/* Tutorial / docs link (only when the entry declares one) */}
      {entry.docs && (
        <p className="text-center mt-3 text-sm text-muted-foreground">
          <button
            type="button"
            onClick={() => { void api.openExternal(entry.docs!.url) }}
            className="text-primary cursor-pointer hover:underline inline-flex items-center gap-1"
          >
            <Lightbulb className="w-4 h-4 text-yellow-500" />
            {entry.docs.label
              ? resolveLocalizedText(entry.docs.label as LocalizedText, getCurrentLanguage())
              : t("Don't know how to get it? View tutorial")}
            <ExternalLink className="w-3 h-3" />
          </button>
        </p>
      )}

      {/* Continue */}
      <button
        onClick={() => onContinue(apiKey.trim())}
        className="w-full mt-4 px-8 py-3 bg-primary text-primary-foreground rounded-lg btn-primary"
      >
        {t('Continue')}
      </button>
    </div>
  )
}
