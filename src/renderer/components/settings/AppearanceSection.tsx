/**
 * Appearance Section Component
 * Manages theme and language settings
 */

import { useState, useCallback, useEffect } from 'react'
import type { HaloConfig, ThemeMode, SendKeyMode } from '../../types'
import { useTranslation, setLanguage, getCurrentLanguage, SUPPORTED_LOCALES, type LocaleCode } from '../../i18n'
import { api } from '../../api'

interface AppearanceSectionProps {
  config: HaloConfig | null
  setConfig: (config: HaloConfig) => void
}

export function AppearanceSection({ config, setConfig }: AppearanceSectionProps) {
  const { t } = useTranslation()

  // Theme state
  const [theme, setTheme] = useState<ThemeMode>(config?.appearance?.theme || 'system')

  // Send key mode state
  const [sendKeyMode, setSendKeyMode] = useState<SendKeyMode>(config?.chat?.sendKeyMode || 'enter')

  // Display scale (persistent UI zoom) — desktop only
  const isDesktop = !api.isRemoteMode()
  const [displayScale, setDisplayScale] = useState(1)
  useEffect(() => {
    if (!isDesktop) return
    void window.halo?.getDisplayScale?.().then((r) => {
      if (r?.success && typeof r.data === 'number') setDisplayScale(r.data)
    })
    // Keep in sync when zoom is changed via keyboard/menu while this panel is open
    return window.halo?.onDisplayScale?.((factor) => setDisplayScale(factor))
  }, [isDesktop])
  const handleScaleChange = async (value: number) => {
    setDisplayScale(value)
    try { await window.halo?.setDisplayScale?.(value) } catch { /* best-effort */ }
  }

  // Auto-save helper for appearance settings
  const autoSave = useCallback(async (partialConfig: Partial<HaloConfig>) => {
    const newConfig = { ...config, ...partialConfig } as HaloConfig
    await api.setConfig(partialConfig)
    setConfig(newConfig)
  }, [config, setConfig])

  // Handle send key mode change with auto-save
  const handleSendKeyModeChange = async (value: SendKeyMode) => {
    setSendKeyMode(value)
    await autoSave({ chat: { ...config?.chat, sendKeyMode: value } })
  }

  // Handle theme change with auto-save
  const handleThemeChange = async (value: ThemeMode) => {
    setTheme(value)
    // Sync to localStorage immediately (for anti-flash on reload)
    try {
      localStorage.setItem('halo-theme', value)
    } catch (e) { /* ignore */ }
    await autoSave({
      appearance: { theme: value }
    })
  }

  return (
    <section id="appearance" className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-medium mb-4">{t('Appearance')}</h2>

      <div className="space-y-6">
        {/* Theme */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">{t('Theme')}</label>
          <div className="flex gap-4">
            {(['light', 'dark', 'system'] as ThemeMode[]).map((themeMode) => (
              <button
                key={themeMode}
                onClick={() => handleThemeChange(themeMode)}
                className={`px-4 py-2 rounded-lg transition-colors ${
                  theme === themeMode
                    ? 'bg-primary/20 text-primary border border-primary'
                    : 'bg-secondary hover:bg-secondary/80'
                }`}
              >
                {themeMode === 'light' ? t('Light') : themeMode === 'dark' ? t('Dark') : t('Follow System')}
              </button>
            ))}
          </div>
        </div>

        {/* Display Size — desktop only */}
        {isDesktop && (
          <div>
            <label className="block text-sm text-muted-foreground mb-2">{t('Display Size')}</label>
            <div className="flex gap-4">
              {([[t('Small'), 0.8], [t('Default'), 1.0], [t('Large'), 1.2]] as [string, number][]).map(([label, val]) => (
                <button
                  key={val}
                  onClick={() => handleScaleChange(val)}
                  className={`px-4 py-2 rounded-lg transition-colors ${
                    Math.abs(displayScale - val) < 0.05
                      ? 'bg-primary/20 text-primary border border-primary'
                      : 'bg-secondary hover:bg-secondary/80'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('Adjust the overall interface size. You can also use ⌘/Ctrl with + / − / 0.')} · {Math.round(displayScale * 100)}%
            </p>
          </div>
        )}

        {/* Language */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">{t('Language')}</label>
          <select
            value={getCurrentLanguage()}
            onChange={(e) => setLanguage(e.target.value as LocaleCode)}
            className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
          >
            {Object.entries(SUPPORTED_LOCALES).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </div>

        {/* Send Key */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">{t('Send Key')}</label>
          <div className="flex gap-4">
            {(['enter', 'ctrl-enter'] as SendKeyMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => handleSendKeyModeChange(mode)}
                className={`px-4 py-2 rounded-lg transition-colors ${
                  sendKeyMode === mode
                    ? 'bg-primary/20 text-primary border border-primary'
                    : 'bg-secondary hover:bg-secondary/80'
                }`}
              >
                {mode === 'enter' ? t('Enter') : t('Ctrl+Enter')}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {sendKeyMode === 'enter' ? t('Press Enter to send, Shift+Enter for new line') : t('Press Ctrl+Enter to send, Enter for new line')}
          </p>
        </div>
      </div>
    </section>
  )
}
