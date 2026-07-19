/**
 * LoginSelector - First-time login method selection
 * Dynamically renders login options based on available providers from product.json
 */

import { useState, useEffect } from 'react'
import { Globe, ChevronDown, ChevronRight, MessageSquare, Wrench, Key, KeyRound, Cloud, Server, Shield, Lock, Zap, LogIn, User, Github, Brain, ExternalLink, type LucideIcon } from 'lucide-react'
import { useTranslation, setLanguage, getCurrentLanguage, SUPPORTED_LOCALES, type LocaleCode } from '../../i18n'
import { api } from '../../api'
import { resolveLocalizedText, type LocalizedText, type AuthProviderConfig } from '../../../shared/types'

// Re-export so existing renderer imports (`from './LoginSelector'`) continue
// to work without churn. The canonical definition lives in shared/types.
export type { AuthProviderConfig }

function getLocalizedText(value: LocalizedText): string {
  return resolveLocalizedText(value, getCurrentLanguage())
}

interface LoginSelectorProps {
  onSelectProvider: (providerType: string) => void
  onSelectCustom: () => void
  /** Invoked when the user selects a preset-API provider entry */
  onSelectPreset: (provider: AuthProviderConfig) => void
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

export function LoginSelector({ onSelectProvider, onSelectCustom, onSelectPreset, onSkip }: LoginSelectorProps) {
  const { t } = useTranslation()

  // Language selector state
  const [isLangDropdownOpen, setIsLangDropdownOpen] = useState(false)
  const [currentLang, setCurrentLang] = useState<LocaleCode>(getCurrentLanguage())

  // Providers state
  const [providers, setProviders] = useState<AuthProviderConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Fetch available providers on mount
  useEffect(() => {
    const fetchProviders = async () => {
      try {
        const result = await api.authGetProviders()
        if (result.success && result.data) {
          setProviders(result.data as AuthProviderConfig[])
        } else {
          // Fallback to default providers if fetch fails
          setProviders([
            {
              type: 'custom',
              displayName: { en: 'Custom API', 'zh-CN': '自定义 API' },
              description: { en: 'Use your own API Key', 'zh-CN': '使用自己的 API Key' },
              icon: 'wrench',
              iconBgColor: '#da7756',
              recommended: true,
              enabled: true
            }
          ])
        }
      } catch (error) {
        console.error('[LoginSelector] Failed to fetch providers:', error)
        // Fallback
        setProviders([
          {
            type: 'custom',
            displayName: { en: 'Custom API', 'zh-CN': '自定义 API' },
            description: { en: 'Use your own API Key', 'zh-CN': '使用自己的 API Key' },
            icon: 'wrench',
            iconBgColor: '#da7756',
            recommended: true,
            enabled: true
          }
        ])
      } finally {
        setIsLoading(false)
      }
    }

    fetchProviders()
  }, [])

  // Handle language change
  const handleLanguageChange = (lang: LocaleCode) => {
    setLanguage(lang)
    setCurrentLang(lang)
    setIsLangDropdownOpen(false)
  }

  // Handle provider selection
  // Routing priority: preset > custom > OAuth provider module.
  // Preset takes precedence over both `path` (mutually exclusive per schema)
  // and the legacy 'custom' shortcut so existing product.json entries keep
  // working unchanged.
  const handleProviderSelect = (provider: AuthProviderConfig) => {
    if (provider.preset) {
      onSelectPreset(provider)
      return
    }
    if (provider.type === 'custom') {
      onSelectCustom()
      return
    }
    onSelectProvider(provider.type)
  }

  // Get icon component for a provider
  const getIcon = (iconName: string): LucideIcon => {
    return iconMap[iconName] || Wrench
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
        <h1 className="mt-4 text-3xl font-light tracking-wide">Halo</h1>
      </div>

      {/* Main content */}
      <div className="w-full max-w-md">
        <h2 className="text-center text-lg mb-8 text-muted-foreground">
          {t('Select AI Login Method')}
        </h2>

        {/* Login options */}
        <div className="space-y-4">
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
            // Dynamic provider cards
            providers.map((provider) => {
              const IconComponent = getIcon(provider.icon)
              const bgColor = hexToRgba(provider.iconBgColor, 0.15)
              const textColor = provider.iconBgColor

              return (
                <button
                  key={provider.type}
                  onClick={() => handleProviderSelect(provider)}
                  className="w-full p-5 bg-card rounded-xl border border-border hover:border-primary/50 hover:bg-card/80 transition-all duration-200 group text-left"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center"
                        style={{ backgroundColor: bgColor }}
                      >
                        <IconComponent className="w-5 h-5" style={{ color: textColor }} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{getLocalizedText(provider.displayName)}</span>
                          {provider.recommended && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-primary/20 text-primary">
                              {t('Recommended')}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mt-0.5">
                          {getLocalizedText(provider.description)}
                        </p>
                        {provider.docs && (
                          <span
                            role="link"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation()
                              void api.openExternal(provider.docs!.url)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                e.stopPropagation()
                                void api.openExternal(provider.docs!.url)
                              }
                            }}
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1.5"
                          >
                            <ExternalLink className="w-3 h-3" />
                            {provider.docs.label
                              ? getLocalizedText(provider.docs.label)
                              : t('Learn more')}
                          </span>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                </button>
              )
            })
          )}
        </div>

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
