/**
 * PreferencesStep - First-launch Step 1: Language + Theme.
 *
 * Shown only when `config.isFirstLaunch === true`. Hard preferences
 * (API key, AI source) live in subsequent SetupPage steps; this step
 * exists so users can pick their language and theme before facing the
 * mandatory configuration. Old users (isFirstLaunch === false) bypass
 * this step entirely and land on the existing LoginSelector.
 *
 * Persistence:
 *   - Language: i18n.changeLanguage + localStorage (via switchLanguage())
 *   - Theme:    localStorage('halo-theme') + config.appearance.theme
 *
 * Theme is applied reactively by App.tsx via the same useEffect that
 * already watches `config?.appearance?.theme`, so writing to config is
 * sufficient — no manual class toggling needed here.
 */

import { useState } from 'react'
import { Globe, ChevronDown, Sun, Moon, Monitor, Loader2 } from 'lucide-react'
import { useTranslation, SUPPORTED_LOCALES, type LocaleCode } from '../../i18n'
import { useLanguagePicker } from '../../hooks/useLanguagePicker'
import { api } from '../../api'
import { useAppStore } from '../../stores/app.store'
import type { HaloConfig, ThemeMode } from '../../types'

interface PreferencesStepProps {
  /** Invoked once preferences are persisted, hands off to LoginSelector. */
  onContinue: () => void
}

// Theme button option metadata, keyed for stable iteration order.
const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; labelKey: string; Icon: typeof Sun }> = [
  { value: 'light',  labelKey: 'Light',         Icon: Sun },
  { value: 'dark',   labelKey: 'Dark',          Icon: Moon },
  { value: 'system', labelKey: 'Follow System', Icon: Monitor }
]

export function PreferencesStep({ onContinue }: PreferencesStepProps) {
  const { t } = useTranslation()
  const { config, setConfig } = useAppStore()

  const [currentLang, pickLanguage] = useLanguagePicker()
  const [isLangDropdownOpen, setIsLangDropdownOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeMode>(config?.appearance?.theme ?? 'system')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleLanguageChange = async (lang: LocaleCode) => {
    setIsLangDropdownOpen(false)
    await pickLanguage(lang)
  }

  // Optimistic local update so the preview reflects immediately; persistence
  // happens on Continue to keep this step atomic and cancelable.
  const handleThemeChange = (value: ThemeMode) => {
    setTheme(value)
    // Anti-flash localStorage sync (mirrors AppearanceSection behavior).
    try { localStorage.setItem('halo-theme', value) } catch { /* noop */ }
    // Apply immediately via store so App.tsx's theme useEffect picks it up
    // and the screen re-paints in the chosen theme before Continue.
    if (config) {
      setConfig({ ...config, appearance: { ...config.appearance, theme: value } } as HaloConfig)
    }
  }

  const handleContinue = async () => {
    if (isSubmitting) return
    setIsSubmitting(true)
    try {
      // Persist theme to backend config. Language is already persisted to
      // localStorage by switchLanguage(); no backend write needed.
      await api.setConfig({ appearance: { theme } })
    } catch (err) {
      // Non-fatal: theme already applied locally via setConfig above; user
      // can re-set in Settings if persistence failed. Log for diagnostics.
      console.error('[PreferencesStep] Failed to persist theme:', err)
    } finally {
      setIsSubmitting(false)
      onContinue()
    }
  }

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-background p-4 sm:p-8">
      {/* Header with Logo */}
      <div className="flex flex-col items-center mb-8 sm:mb-10">
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full border-2 border-primary/60 flex items-center justify-center halo-glow">
          <div className="w-11 h-11 sm:w-14 sm:h-14 rounded-full bg-gradient-to-br from-primary/30 to-transparent" />
        </div>
        <h1 className="mt-4 text-2xl sm:text-3xl font-light tracking-wide">Halo</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("Let's set things up")}</p>
      </div>

      {/* Main card */}
      <div className="w-full max-w-md space-y-5 sm:space-y-6">
        {/* Language */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            {t('Language')}
          </label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsLangDropdownOpen(prev => !prev)}
              className="w-full flex items-center justify-between gap-2 px-4 py-2.5 bg-card border border-border rounded-lg hover:border-primary/50 transition-colors text-left"
            >
              <span className="flex items-center gap-2 text-sm text-foreground">
                <Globe className="w-4 h-4 text-muted-foreground" />
                {SUPPORTED_LOCALES[currentLang]}
              </span>
              <ChevronDown
                className={`w-4 h-4 text-muted-foreground transition-transform ${isLangDropdownOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {isLangDropdownOpen && (
              <>
                {/* Click-outside backdrop */}
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setIsLangDropdownOpen(false)}
                />
                <div className="absolute left-0 right-0 mt-1 py-1 bg-card border border-border rounded-lg shadow-lg z-20 max-h-64 overflow-y-auto">
                  {Object.entries(SUPPORTED_LOCALES).map(([code, name]) => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => void handleLanguageChange(code as LocaleCode)}
                      className={`w-full px-4 py-2 text-left text-sm hover:bg-secondary/80 transition-colors ${
                        currentLang === code ? 'text-primary font-medium' : 'text-foreground'
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Theme */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            {t('Theme')}
          </label>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {THEME_OPTIONS.map(({ value, labelKey, Icon }) => {
              const isSelected = theme === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => handleThemeChange(value)}
                  className={`flex flex-col items-center justify-center gap-1.5 px-2 py-3 sm:py-4 rounded-lg border transition-colors ${
                    isSelected
                      ? 'bg-primary/15 border-primary text-primary'
                      : 'bg-card border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                  }`}
                  aria-pressed={isSelected}
                >
                  <Icon className="w-5 h-5" />
                  <span className="text-xs sm:text-sm">{t(labelKey)}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Continue button */}
        <button
          type="button"
          onClick={handleContinue}
          disabled={isSubmitting}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 sm:py-3 bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground rounded-lg transition-colors text-sm font-medium"
        >
          {isSubmitting ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              {t('Saving...')}
            </>
          ) : (
            t('Continue')
          )}
        </button>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 pt-1">
          <span className="w-1.5 h-1.5 rounded-full bg-primary" />
          <span className="w-1.5 h-1.5 rounded-full bg-border" />
          <span className="ml-2 text-xs text-muted-foreground">
            {t('Step {{current}} of {{total}}', { current: 1, total: 2 })}
          </span>
        </div>
      </div>
    </div>
  )
}
