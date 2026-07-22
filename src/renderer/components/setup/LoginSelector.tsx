/**
 * LoginSelector - First-time login method selection.
 *
 * Renders the product.json auth providers (in `authProviders` order) as a
 * three-tier layout:
 *   - Hero: the first `recommended` non-BYOK provider; when nothing is
 *     recommended the first managed-login provider is promoted so there is
 *     always a lead action.
 *   - Secondary: the remaining managed-login providers as bordered rows.
 *   - Custom API (BYOK): a bordered row that navigates to the key-first config
 *     panel (owned by SetupPage), mirroring the preset entry's step navigation.
 *
 * Entries flagged `setupHidden` in product.json are filtered out here so they
 * stay out of onboarding while remaining available in the in-app AI settings.
 */

import { useState, useEffect, useMemo } from 'react'
import type React from 'react'
import { Globe, ChevronDown, ChevronRight, MessageSquare, Wrench, Key, KeyRound, Cloud, Server, Shield, Lock, Zap, LogIn, User, Github, Brain, type LucideIcon } from 'lucide-react'
import { useTranslation, setLanguage, getCurrentLanguage, SUPPORTED_LOCALES, type LocaleCode } from '../../i18n'
import { api } from '../../api'
import { resolveLocalizedText, type LocalizedText, type AuthProviderConfig } from '../../../shared/types'
import { getApiKeyProviders } from '../../types'
import { getBrandIcon } from '../icons/BrandIcons'

// Re-export so existing renderer imports (`from './LoginSelector'`) continue
// to work without churn. The canonical definition lives in shared/types.
export type { AuthProviderConfig }

/**
 * Whether a login entry renders as the inline BYOK ("bring your own key") form
 * rather than a navigate-on-click card. Centralised so the `type === 'custom'`
 * check lives in one place.
 */
function isByokEntry(entry: AuthProviderConfig): boolean {
  return entry.type === 'custom' && !entry.preset
}

function getLocalizedText(value: LocalizedText): string {
  return resolveLocalizedText(value, getCurrentLanguage())
}

interface LoginSelectorProps {
  onSelectProvider: (providerType: string) => void
  /** Invoked when the user selects a preset-API provider entry */
  onSelectPreset: (provider: AuthProviderConfig) => void
  /** Invoked when the user selects the Custom API (BYOK) entry */
  onSelectCustom: (entry: AuthProviderConfig) => void
  /** Invoked when the user defers model configuration and enters Home directly */
  onSkip?: () => void
}

/**
 * Map icon names to Lucide components
 * Supported icons: log-in, user, globe, key, cloud, server, shield, lock, zap, message-square, wrench
 */
const iconMap: Record<string, LucideIcon> = {
  'log-in': LogIn,
  'user': User,
  'globe': Globe,
  'key': Key,
  'key-round': KeyRound,
  'cloud': Cloud,
  'server': Server,
  'shield': Shield,
  'lock': Lock,
  'zap': Zap,
  'message-square': MessageSquare,
  'wrench': Wrench,
  'github': Github,
  'brain': Brain
}

/**
 * Convert hex color to RGBA with opacity
 */
function hexToRgba(hex: string, alpha: number = 0.15): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return `rgba(128, 128, 128, ${alpha})`
  return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`
}

/** Default fallback providers when the product.json fetch fails. */
const FALLBACK_PROVIDERS: AuthProviderConfig[] = [
  {
    type: 'custom',
    displayName: { en: 'Custom API', 'zh-CN': '自定义 API' },
    description: { en: 'Use your own API Key', 'zh-CN': '使用自己的 API Key' },
    icon: 'wrench',
    iconBgColor: '#da7756',
    recommended: true,
    enabled: true
  }
]

type IconComponent = React.ComponentType<{ className?: string; style?: React.CSSProperties }>

/** Number of provider-name chips previewed under the collapsed Custom API row. */
const CUSTOM_CHIP_COUNT = 5

export function LoginSelector({ onSelectProvider, onSelectPreset, onSelectCustom, onSkip }: LoginSelectorProps) {
  const { t } = useTranslation()

  // Language selector state
  const [isLangDropdownOpen, setIsLangDropdownOpen] = useState(false)
  const [currentLang, setCurrentLang] = useState<LocaleCode>(getCurrentLanguage())

  // Providers state
  const [providers, setProviders] = useState<AuthProviderConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Fetch available providers on mount. `setupHidden` entries are dropped here so
  // they stay out of first-run onboarding while remaining in the in-app settings
  // (which reads the same list without this filter).
  useEffect(() => {
    const fetchProviders = async () => {
      try {
        const result = await api.authGetProviders()
        const list = result.success && result.data
          ? (result.data as AuthProviderConfig[])
          : FALLBACK_PROVIDERS
        setProviders(list.filter(p => !p.setupHidden))
      } catch (error) {
        console.error('[LoginSelector] Failed to fetch providers:', error)
        setProviders(FALLBACK_PROVIDERS)
      } finally {
        setIsLoading(false)
      }
    }

    fetchProviders()
  }, [])

  const catalog = useMemo(() => getApiKeyProviders(), [])
  const customChips = useMemo(() => {
    const recommendedFirst = [...catalog].sort(
      (a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0)
    )
    return recommendedFirst.slice(0, CUSTOM_CHIP_COUNT).map(p => t(p.name))
  }, [catalog, t])
  const customExtra = Math.max(0, catalog.length - CUSTOM_CHIP_COUNT)

  // Handle language change
  const handleLanguageChange = (lang: LocaleCode) => {
    setLanguage(lang)
    setCurrentLang(lang)
    setIsLangDropdownOpen(false)
  }

  // Preset entries open the locked preset form; everything else is an OAuth provider.
  const handleProviderSelect = (provider: AuthProviderConfig) => {
    if (provider.preset) {
      onSelectPreset(provider)
      return
    }
    onSelectProvider(provider.type)
  }

  const getIconComponent = (provider: AuthProviderConfig): IconComponent =>
    getBrandIcon(provider.type) || iconMap[provider.icon] || Wrench

  // Role assignment (config order preserved).
  const managedProviders = providers.filter(p => !isByokEntry(p))
  const byokEntry = providers.find(isByokEntry)
  const heroProvider = managedProviders.find(p => p.recommended) ?? managedProviders[0]
  const secondaryProviders = managedProviders.filter(p => p !== heroProvider)

  // Hero: full-width primary button with an always-on docs link ("no key yet?").
  const renderHero = (provider: AuthProviderConfig) => {
    const Icon = getIconComponent(provider)
    // Preset entries carry their docs under `preset.docs` (the same link the
    // API-key form shows); fall back to it so the hero still surfaces a guide.
    const docs = provider.docs ?? provider.preset?.docs
    return (
      <div>
        <button
          onClick={() => handleProviderSelect(provider)}
          className="login-hero w-full flex flex-col items-start gap-1 p-4 rounded-xl text-left"
        >
          <span className="flex items-center gap-2 text-[15px] font-semibold">
            <Icon className="w-5 h-5" />
            {getLocalizedText(provider.displayName)}
          </span>
          <span className="login-hero-sub text-xs">
            {getLocalizedText(provider.description)}
          </span>
        </button>
        {docs && (
          <p className="mt-1.5 text-center text-xs text-muted-foreground">
            {t('No key yet?')}{' '}
            <button
              type="button"
              onClick={() => { void api.openExternal(docs.url) }}
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              {docs.label ? getLocalizedText(docs.label) : t('View application guide')}
              <ChevronRight className="w-3 h-3" />
            </button>
          </p>
        )}
      </div>
    )
  }

  // Secondary: bordered navigate-on-click row, with the entry's optional docs
  // link below (kept outside the row button to avoid nesting interactives).
  const renderSecondary = (provider: AuthProviderConfig) => {
    const Icon = getIconComponent(provider)
    const docs = provider.docs ?? provider.preset?.docs
    return (
      <div key={provider.type}>
        <button
          onClick={() => handleProviderSelect(provider)}
          className="w-full flex items-center gap-3 p-3 bg-card rounded-xl border border-border hover:border-primary/50 hover:bg-card/80 transition-all duration-200 group text-left"
        >
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: hexToRgba(provider.iconBgColor, 0.15) }}
          >
            <Icon className="w-5 h-5" style={{ color: provider.iconBgColor }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">{getLocalizedText(provider.displayName)}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{getLocalizedText(provider.description)}</div>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
        </button>
        {docs && (
          <p className="mt-1 pl-1 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={() => { void api.openExternal(docs.url) }}
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              {docs.label ? getLocalizedText(docs.label) : t('View application guide')}
              <ChevronRight className="w-3 h-3" />
            </button>
          </p>
        )}
      </div>
    )
  }

  // Custom API: navigate-on-click row that opens the key-first config panel
  // (mirrors the preset entry's step navigation rather than expanding inline).
  const renderCustom = (entry: AuthProviderConfig) => {
    const Icon = getIconComponent(entry)
    return (
      <button
        onClick={() => onSelectCustom(entry)}
        className="w-full flex items-center gap-3 p-3 bg-card rounded-xl border border-border hover:border-primary/50 hover:bg-card/80 transition-all duration-200 group text-left"
      >
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: hexToRgba(entry.iconBgColor, 0.15) }}
        >
          <Icon className="w-5 h-5" style={{ color: entry.iconBgColor }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{getLocalizedText(entry.displayName)}</div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate">{getLocalizedText(entry.description)}</div>
          {customChips.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {customChips.map(name => (
                <span key={name} className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                  {name}
                </span>
              ))}
              {customExtra > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                  +{customExtra}
                </span>
              )}
            </div>
          )}
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
      </button>
    )
  }

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-background p-8 relative">
      {/* Language Selector - Top Right */}
      <div className="absolute top-6 right-6">
        <div className="relative">
          <button
            onClick={() => setIsLangDropdownOpen(!isLangDropdownOpen)}
            className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 rounded-lg transition-colors"
          >
            <Globe className="w-4 h-4" />
            <span>{SUPPORTED_LOCALES[currentLang]}</span>
            <ChevronDown className={`w-4 h-4 transition-transform ${isLangDropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {/* Dropdown */}
          {isLangDropdownOpen && (
            <>
              {/* Backdrop to close dropdown */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => setIsLangDropdownOpen(false)}
              />
              <div className="absolute right-0 mt-1 py-1 w-40 bg-card border border-border rounded-lg shadow-lg z-20">
                {Object.entries(SUPPORTED_LOCALES).map(([code, name]) => (
                  <button
                    key={code}
                    onClick={() => handleLanguageChange(code as LocaleCode)}
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

      {/* Header with Logo */}
      <div className="flex flex-col items-center mb-10">
        {/* Logo with halo glow effect */}
        <div className="w-20 h-20 rounded-full border-2 border-primary/60 flex items-center justify-center halo-glow">
          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-primary/30 to-transparent" />
        </div>
        <h1 className="mt-4 text-3xl font-light tracking-wide">{t('Welcome to Halo')}</h1>
      </div>

      {/* Main content */}
      <div className="w-full max-w-md">
        <h2 className="text-center text-lg mb-8 text-muted-foreground">
          {t('Select a method to start')}
        </h2>

        {isLoading ? (
          // Loading skeleton
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <div key={i} className="w-full p-5 bg-card rounded-xl border border-border animate-pulse">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-secondary" />
                  <div className="flex-1">
                    <div className="h-4 bg-secondary rounded w-32 mb-2" />
                    <div className="h-3 bg-secondary rounded w-48" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {heroProvider && renderHero(heroProvider)}

            {secondaryProviders.length > 0 && (
              <div className="flex items-center gap-3 py-1">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {t('Or choose another method')}
                </span>
                <div className="flex-1 h-px bg-border" />
              </div>
            )}

            {secondaryProviders.map(renderSecondary)}
            {byokEntry && renderCustom(byokEntry)}
          </div>
        )}

        {onSkip && !isLoading && (
          <div className="mt-6 text-center">
            <button
              onClick={onSkip}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
            >
              {t('Skip for now')}
            </button>
            <p className="mt-1 text-xs text-muted-foreground/70">
              {t('Configure your AI later in Settings')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
