/**
 * SetupPage - Multi-source login flow
 * Handles the first-time setup with OAuth providers or Custom API
 * Dynamically supports any provider configured in product.json
 */

import { useState, useEffect } from 'react'
import { useAppStore } from '../stores/app.store'
import { api } from '../api'
import { LoginSelector, type AuthProviderConfig } from '../components/setup/LoginSelector'
import { ApiSetup } from '../components/setup/ApiSetup'
import { PreferencesStep } from '../components/setup/PreferencesStep'
import { useTranslation } from '../i18n'
import { Loader2, Brain, ExternalLink, Copy, Check } from 'lucide-react'

// First step is `preferences` only on the very first launch (gated by
// config.isFirstLaunch). Old users re-entering Setup (e.g., after clearing
// the AI source) skip preferences and land on `select` directly.
type SetupStep = 'preferences' | 'select' | 'oauth-waiting' | 'claude-login' | 'custom' | 'preset'

/** Device code info for display in UI */
interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
}

/** Claude OAuth login dialog state */
interface ClaudeLoginState {
  loginUrl: string
  state: string
  /** Redirect URI the BrowserWindow should intercept (provider-owned) */
  redirectUri: string
  manualCode: string
  autoLoginInProgress: boolean
  error: string | null
  copied: boolean
  submitting: boolean
}

export function SetupPage() {
  const { t } = useTranslation()
  const { setView, setConfig, config } = useAppStore()
  // Step is derived per render so the wizard remains correct even if:
  //   (a) `config` arrives after SetupPage first mounts (async IPC race), or
  //   (b) React Fast Refresh preserves stale useState across HMR.
  // The `hasPassedPreferences` flag is the one-way latch that lets the user
  // move forward; once true, internal `step` state controls navigation.
  const [hasPassedPreferences, setHasPassedPreferences] = useState(false)
  const [step, setStep] = useState<SetupStep>('select')
  const shouldShowPreferences = config?.isFirstLaunch === true && !hasPassedPreferences
  const effectiveStep: SetupStep = shouldShowPreferences ? 'preferences' : step

  const [currentProvider, setCurrentProvider] = useState<string | null>(null)
  const [oauthState, setOauthState] = useState<string | null>(null)
  const [loginStatus, setLoginStatus] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [deviceCodeInfo, setDeviceCodeInfo] = useState<DeviceCodeInfo | null>(null)
  const [claudeLogin, setClaudeLogin] = useState<ClaudeLoginState | null>(null)
  // Preset-API entry currently being configured (drives the ApiSetup form)
  const [presetProvider, setPresetProvider] = useState<AuthProviderConfig | null>(null)

  // Handle OAuth provider login (generic)
  const handleSelectProvider = async (providerType: string) => {
    setError(null)
    setCurrentProvider(providerType)
    setStep('oauth-waiting')
    setLoginStatus(t('Opening login page...'))
    setDeviceCodeInfo(null)

    try {
      // Start the login flow - this opens the browser
      const result = await api.authStartLogin(providerType)
      if (!result.success) {
        throw new Error(result.error || t('Failed to start login'))
      }

      const { loginUrl, state, userCode, verificationUri, redirectUri } = result.data as {
        loginUrl: string
        state: string
        userCode?: string
        verificationUri?: string
        redirectUri?: string
      }
      setOauthState(state)

      // ── Claude OAuth: show dual-mode login dialog ──────────────────────
      if (providerType === 'claude' && loginUrl && !userCode) {
        setStep('claude-login')
        setClaudeLogin({
          loginUrl,
          state,
          redirectUri: redirectUri ?? '',
          manualCode: '',
          autoLoginInProgress: false,
          error: null,
          copied: false,
          submitting: false
        })
        return
      }

      // If device code flow, show user code and verification URL
      if (userCode && verificationUri) {
        setDeviceCodeInfo({ userCode, verificationUri })
        setLoginStatus(t('Enter the code in your browser'))
      } else {
        setLoginStatus(t('Waiting for login...'))
      }

      // Complete the login - this polls for the token
      const completeResult = await api.authCompleteLogin(providerType, state)
      if (!completeResult.success) {
        throw new Error(completeResult.error || t('Login failed'))
      }

      // Success! Reload config and go to home
      const configResult = await api.getConfig()
      if (configResult.success && configResult.data) {
        setConfig(configResult.data as any)
      }

      setView('home')
    } catch (err) {
      console.error(`[SetupPage] ${providerType} login error:`, err)
      setError(err instanceof Error ? err.message : t('Login failed'))
      setStep('select')
      setCurrentProvider(null)
    }
  }

  // ── Claude: "Direct Login" button handler ────────────────────────────
  const handleClaudeDirectLogin = async () => {
    if (!claudeLogin) return
    if (!claudeLogin.redirectUri) {
      setClaudeLogin(prev => prev ? { ...prev, error: t('Login flow misconfigured (missing redirect URI). Please retry.') } : null)
      return
    }
    setClaudeLogin(prev => prev ? { ...prev, autoLoginInProgress: true, error: null } : null)

    try {
      const windowResult = await api.authOpenLoginWindow('claude', claudeLogin.loginUrl, claudeLogin.redirectUri)

      if (!windowResult.success) {
        const errMsg = windowResult.error || t('Login failed')
        if (errMsg === 'Login window closed') {
          setClaudeLogin(prev => prev ? { ...prev, autoLoginInProgress: false } : null)
          return
        }
        setClaudeLogin(prev => prev ? { ...prev, autoLoginInProgress: false, error: errMsg } : null)
        return
      }

      // Success! Reload config and go to home
      const configResult = await api.getConfig()
      if (configResult.success && configResult.data) {
        setConfig(configResult.data as any)
      }
      setClaudeLogin(null)
      setView('home')
    } catch (err) {
      setClaudeLogin(prev => prev ? {
        ...prev,
        autoLoginInProgress: false,
        error: err instanceof Error ? err.message : t('Login failed')
      } : null)
    }
  }

  // ── Claude: "Submit Code" button handler ─────────────────────────────
  const handleClaudeManualLogin = async () => {
    if (!claudeLogin || !claudeLogin.manualCode.trim()) return
    setClaudeLogin(prev => prev ? { ...prev, submitting: true, error: null } : null)

    try {
      const completeResult = await api.authCompleteLogin('claude', claudeLogin.manualCode.trim())
      if (!completeResult.success) {
        setClaudeLogin(prev => prev ? {
          ...prev,
          submitting: false,
          error: completeResult.error || t('Login failed')
        } : null)
        return
      }

      // Success! Reload config and go to home
      const configResult = await api.getConfig()
      if (configResult.success && configResult.data) {
        setConfig(configResult.data as any)
      }
      setClaudeLogin(null)
      setView('home')
    } catch (err) {
      setClaudeLogin(prev => prev ? {
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : t('Login failed')
      } : null)
    }
  }

  // ── Claude: Copy URL to clipboard ────────────────────────────────────
  const handleClaudeCopyUrl = async () => {
    if (!claudeLogin) return
    try {
      await navigator.clipboard.writeText(claudeLogin.loginUrl)
      setClaudeLogin(prev => prev ? { ...prev, copied: true } : null)
      setTimeout(() => {
        setClaudeLogin(prev => prev ? { ...prev, copied: false } : null)
      }, 2000)
    } catch {
      // Fallback: text is already selectable in the URL display
    }
  }

  // Handle Custom API selection
  const handleSelectCustom = () => {
    setStep('custom')
  }

  // Handle skip — defer model configuration and enter Home directly.
  // The modelConfigSkipped flag tells the setup-entry guard not to re-show
  // the wizard on next launch despite the empty aiSources.
  const handleSkipModelConfig = async () => {
    setError(null)
    try {
      const configResult = await api.getConfig()
      if (!configResult.success || !configResult.data) {
        setError(t('Failed to load config'))
        return
      }
      const newConfig = {
        ...(configResult.data as any),
        isFirstLaunch: false,
        modelConfigSkipped: true
      }
      await api.setConfig(newConfig)
      setConfig(newConfig)
      setView('home')
    } catch (err) {
      console.error('[SetupPage] skip error:', err)
      setError(err instanceof Error ? err.message : t('Skip failed'))
    }
  }

  // Handle back from Custom API
  const handleBackFromCustom = () => {
    setStep('select')
  }

  // Handle preset-API selection (fixed-baseUrl API key form)
  const handleSelectPreset = (provider: AuthProviderConfig) => {
    setPresetProvider(provider)
    setStep('preset')
  }

  // Handle back from preset
  const handleBackFromPreset = () => {
    setPresetProvider(null)
    setStep('select')
  }

  // Listen for login progress updates (generic)
  useEffect(() => {
    if (step !== 'oauth-waiting' || !currentProvider) return

    // Listen to generic auth progress
    const unsubscribe = api.onAuthLoginProgress((data: { provider: string; status: string }) => {
      if (data.provider === currentProvider) {
        setLoginStatus(data.status)
      }
    })

    return unsubscribe
  }, [step, currentProvider])

  // Render based on derived step (see hasPassedPreferences comment above)
  if (effectiveStep === 'preferences') {
    return <PreferencesStep onContinue={() => setHasPassedPreferences(true)} />
  }

  if (effectiveStep === 'select') {
    return (
      <>
        <LoginSelector
          onSelectProvider={handleSelectProvider}
          onSelectCustom={handleSelectCustom}
          onSelectPreset={handleSelectPreset}
          onSkip={handleSkipModelConfig}
        />
        {error && (
          <div className="fixed bottom-8 left-1/2 -translate-x-1/2 p-4 bg-destructive/10 border border-destructive/20 rounded-lg z-50">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}
      </>
    )
  }

  if (step === 'claude-login' && claudeLogin) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-background p-8">
        {/* Header with Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-20 h-20 rounded-full border-2 border-primary/60 flex items-center justify-center halo-glow">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-primary/30 to-transparent" />
          </div>
          <h1 className="mt-4 text-3xl font-light tracking-wide">Halo</h1>
        </div>

        {/* Claude Login Card */}
        <div className="w-full max-w-md space-y-5">
          {/* Header */}
          <div className="flex items-center gap-3 justify-center">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center"
                 style={{ backgroundColor: 'rgba(217, 119, 87, 0.15)' }}>
              <Brain size={20} style={{ color: '#d97757' }} />
            </div>
            <div>
              <h2 className="font-medium text-foreground">{t('Claude Login')}</h2>
              <p className="text-xs text-muted-foreground">{t('Choose a login method')}</p>
            </div>
          </div>

          {/* Error display */}
          {claudeLogin.error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
              <p className="text-sm text-destructive">{claudeLogin.error}</p>
            </div>
          )}

          {/* Option 1: Direct Login */}
          <div className="p-4 bg-card border border-border rounded-xl space-y-3">
            <h4 className="text-sm font-medium text-foreground">
              {t('Option 1: Direct Login')}
            </h4>
            <p className="text-xs text-muted-foreground">
              {t('Requires access to claude.ai (with proxy or direct connection)')}
            </p>
            <button
              onClick={handleClaudeDirectLogin}
              disabled={claudeLogin.autoLoginInProgress || claudeLogin.submitting}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                       bg-[#d97757] hover:bg-[#c5684a] disabled:opacity-50
                       text-white rounded-lg transition-colors text-sm font-medium"
            >
              {claudeLogin.autoLoginInProgress ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {t('Logging in...')}
                </>
              ) : (
                <>
                  <ExternalLink size={16} />
                  {t('Open Login Window')}
                </>
              )}
            </button>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground">{t('or')}</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          {/* Option 2: Manual Code Paste (partner-assisted) */}
          <div className="p-4 bg-card border border-border rounded-xl space-y-3">
            <h4 className="text-sm font-medium text-foreground">
              {t('Option 2: Partner-Assisted Login')}
            </h4>
            <p className="text-xs text-muted-foreground">
              {t('Copy the link below and send it to your service provider')}
            </p>

            {/* URL display with copy button */}
            <div className="flex items-center gap-2">
              <div className="flex-1 p-2.5 bg-muted/50 rounded-md border border-border
                            font-mono text-xs text-muted-foreground break-all select-all overflow-hidden max-h-16 overflow-y-auto">
                {claudeLogin.loginUrl}
              </div>
              <button
                onClick={handleClaudeCopyUrl}
                className="shrink-0 flex items-center gap-1 px-3 py-2.5 text-sm
                         bg-muted/50 hover:bg-muted
                         border border-border rounded-md transition-colors"
                title={t('Copy link')}
              >
                <Copy size={14} className={claudeLogin.copied ? 'text-green-500' : 'text-muted-foreground'} />
                <span className={`text-xs ${claudeLogin.copied ? 'text-green-500' : 'text-muted-foreground'}`}>
                  {claudeLogin.copied ? t('Copied') : t('Copy')}
                </span>
              </button>
            </div>

            {/* Manual code input */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {t('Paste the authorization code from your service provider')}
              </p>
              <input
                type="text"
                value={claudeLogin.manualCode}
                onChange={(e) => setClaudeLogin(prev => prev ? { ...prev, manualCode: e.target.value } : null)}
                placeholder={t('Paste authorization code here')}
                className="w-full px-3 py-2.5 bg-background border border-border rounded-md
                         text-sm text-foreground placeholder:text-muted-foreground
                         focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30
                         font-mono"
                disabled={claudeLogin.submitting}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && claudeLogin.manualCode.trim()) {
                    handleClaudeManualLogin()
                  }
                }}
              />
            </div>

            {/* Submit button */}
            <button
              onClick={handleClaudeManualLogin}
              disabled={!claudeLogin.manualCode.trim() || claudeLogin.submitting || claudeLogin.autoLoginInProgress}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                       bg-primary hover:bg-primary/90 disabled:opacity-50
                       text-white rounded-lg transition-colors text-sm font-medium"
            >
              {claudeLogin.submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {t('Verifying...')}
                </>
              ) : (
                <>
                  <Check size={16} />
                  {t('Complete Login')}
                </>
              )}
            </button>
          </div>

          {/* Cancel button */}
          <button
            onClick={() => {
              setClaudeLogin(null)
              setStep('select')
              setCurrentProvider(null)
            }}
            disabled={claudeLogin.autoLoginInProgress || claudeLogin.submitting}
            className="w-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('Cancel')}
          </button>
        </div>
      </div>
    )
  }

  if (step === 'oauth-waiting') {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-background p-8">
        {/* Header with Logo */}
        <div className="flex flex-col items-center mb-10">
          <div className="w-20 h-20 rounded-full border-2 border-primary/60 flex items-center justify-center halo-glow">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-primary/30 to-transparent" />
          </div>
          <h1 className="mt-4 text-3xl font-light tracking-wide">Halo</h1>
        </div>

        {/* Loading state */}
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-muted-foreground">{loginStatus}</p>

          {/* Device code display for OAuth Device Code flow */}
          {deviceCodeInfo && (
            <div className="mt-4 p-6 bg-muted/50 border border-border rounded-lg text-center">
              <p className="text-sm text-muted-foreground mb-2">
                {t('Visit this URL to login:')}
              </p>
              <a
                href={deviceCodeInfo.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline font-mono text-sm"
              >
                {deviceCodeInfo.verificationUri}
              </a>
              <p className="text-sm text-muted-foreground mt-4 mb-2">
                {t('Enter this code:')}
              </p>
              <div className="flex items-center justify-center gap-2">
                <code className="text-2xl font-bold font-mono tracking-widest bg-background px-4 py-2 rounded border border-border select-all">
                  {deviceCodeInfo.userCode}
                </code>
                <button
                  onClick={() => navigator.clipboard.writeText(deviceCodeInfo.userCode)}
                  className="p-2 text-muted-foreground hover:text-foreground transition-colors"
                  title={t('Copy code')}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                  </svg>
                </button>
              </div>
            </div>
          )}

          {!deviceCodeInfo && (
            <p className="text-sm text-muted-foreground/70">
              {t('Please complete login in your browser')}
            </p>
          )}
        </div>

        {/* Error message */}
        {error && (
          <div className="mt-6 p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Cancel button */}
        <button
          onClick={() => {
            setStep('select')
            setCurrentProvider(null)
          }}
          className="mt-8 px-6 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('Cancel')}
        </button>
      </div>
    )
  }

  if (step === 'custom') {
    return <ApiSetup showBack onBack={handleBackFromCustom} />
  }

  if (step === 'preset' && presetProvider) {
    return (
      <ApiSetup
        showBack
        onBack={handleBackFromPreset}
        preset={presetProvider}
      />
    )
  }

  return null
}
