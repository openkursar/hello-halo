/**
 * SetupPage - Multi-source login flow
 * Handles the first-time setup with OAuth providers or Custom API
 * Dynamically supports any provider configured in product.json
 */

import { useState } from 'react'
import { useAppStore } from '../stores/app.store'
import { api } from '../api'
import { LoginSelector, type AuthProviderConfig } from '../components/setup/LoginSelector'
import { SetupProviderConfig } from '../components/setup/SetupProviderConfig'
import { PreferencesStep } from '../components/setup/PreferencesStep'
import { OAuthRedirectLogin } from '../components/ai-config/OAuthRedirectLogin'
import { useOAuthLogin } from '../hooks/useOAuthLogin'
import { useTranslation } from '../i18n'
import { Loader2 } from 'lucide-react'
import type { HaloConfig } from '../types'

// First step is `preferences` only on the very first launch (gated by
// config.isFirstLaunch). Old users re-entering Setup (e.g., after clearing
// the AI source) skip preferences and land on `select` directly. A running
// OAuth login takes over the screen until it finishes or is cancelled.
type SetupStep = 'preferences' | 'select' | 'config'

export function SetupPage() {
  const { t } = useTranslation()
  const { enterApp, setConfig, config } = useAppStore()
  // Step is derived per render so the wizard remains correct even if:
  //   (a) `config` arrives after SetupPage first mounts (async IPC race), or
  //   (b) React Fast Refresh preserves stale useState across HMR.
  // The `hasPassedPreferences` flag is the one-way latch that lets the user
  // move forward; once true, internal `step` state controls navigation.
  const [hasPassedPreferences, setHasPassedPreferences] = useState(false)
  const [step, setStep] = useState<SetupStep>('select')
  const shouldShowPreferences = config?.isFirstLaunch === true && !hasPassedPreferences
  const effectiveStep: SetupStep = shouldShowPreferences ? 'preferences' : step

  const [error, setError] = useState<string | null>(null)
  const [configEntry, setConfigEntry] = useState<AuthProviderConfig | null>(null)

  const oauth = useOAuthLogin({
    onError: setError,
    onSignedIn: async () => {
      const result = await api.getConfig()
      if (!result.success || !result.data) throw new Error(result.error || t('Failed to load config'))
      setConfig(result.data as HaloConfig)
      await enterApp()
    }
  })

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
      await enterApp()
    } catch (err) {
      console.error('[SetupPage] skip error:', err)
      setError(err instanceof Error ? err.message : t('Skip failed'))
    }
  }

  // Handle preset-API selection (fixed-baseUrl API key form)
  const handleSelectPreset = (provider: AuthProviderConfig) => {
    setConfigEntry(provider)
    setStep('config')
  }

  // Handle Custom API (BYOK) selection — same config step, key-first form
  const handleSelectCustom = (entry: AuthProviderConfig) => {
    setConfigEntry(entry)
    setStep('config')
  }

  // Handle back from the config step
  const handleBackFromConfig = () => {
    setConfigEntry(null)
    setStep('select')
  }

  // Render based on derived step (see hasPassedPreferences comment above)
  if (effectiveStep === 'preferences') {
    return <PreferencesStep onContinue={() => setHasPassedPreferences(true)} />
  }

  if (oauth.login?.redirect) {
    return (
      <div className="h-full w-full overflow-y-auto flex flex-col items-center bg-background p-4 sm:p-8">
        <div className="flex flex-col items-center shrink-0 mt-auto mb-8">
          <div className="w-20 h-20 rounded-full border-2 border-primary/60 flex items-center justify-center halo-glow">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-primary/30 to-transparent" />
          </div>
          <h1 className="mt-4 text-3xl font-light tracking-wide">{t('Halo')}</h1>
        </div>
        <div className="w-full min-w-0 max-w-md shrink-0 mb-auto">
          <OAuthRedirectLogin
            title={t('Sign in')}
            redirect={oauth.login.redirect}
            onOpenWindow={oauth.openLoginWindow}
            onSubmitCode={oauth.submitCode}
            onCodeChange={oauth.setManualCode}
            onCopyLink={oauth.copyLoginUrl}
            onCancel={oauth.cancel}
          />
        </div>
      </div>
    )
  }

  if (oauth.login) {
    const { phase, userCode, verificationUri } = oauth.login
    const status = phase === 'starting'
      ? t('Opening login page...')
      : userCode ? t('Enter the code in your browser') : t('Waiting for login...')
    return (
      <div className="h-full w-full overflow-y-auto flex flex-col items-center bg-background p-4 sm:p-8">
        {/* Header with Logo */}
        <div className="flex flex-col items-center shrink-0 mt-auto mb-10">
          <div className="w-20 h-20 rounded-full border-2 border-primary/60 flex items-center justify-center halo-glow">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-primary/30 to-transparent" />
          </div>
          <h1 className="mt-4 text-3xl font-light tracking-wide">{t('Halo')}</h1>
        </div>

        {/* Loading state */}
        <div className="w-full min-w-0 max-w-md shrink-0 flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-muted-foreground">{status}</p>

          {/* Device code display for OAuth Device Code flow */}
          {userCode && verificationUri && (
            <div className="w-full min-w-0 mt-4 p-4 sm:p-6 bg-muted/50 border border-border rounded-lg text-center">
              <p className="text-sm text-muted-foreground mb-2">
                {t('Visit this URL to login:')}
              </p>
              <a
                href={verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline font-mono text-sm break-all"
              >
                {verificationUri}
              </a>
              <p className="text-sm text-muted-foreground mt-4 mb-2">
                {t('Enter this code:')}
              </p>
              <div className="flex items-center justify-center gap-2">
                <code className="text-2xl font-bold font-mono tracking-widest bg-background px-4 py-2 rounded border border-border select-all">
                  {userCode}
                </code>
                <button
                  onClick={() => navigator.clipboard.writeText(userCode)}
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

          {!userCode && (
            <p className="text-sm text-muted-foreground/70">
              {t('Please complete login in your browser')}
            </p>
          )}
        </div>

        {/* Cancel button */}
        <button
          onClick={oauth.cancel}
          className="shrink-0 mt-8 mb-auto px-6 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('Cancel')}
        </button>
      </div>
    )
  }

  if (effectiveStep === 'select') {
    return (
      <>
        <LoginSelector
          onSelectProvider={provider => oauth.start(provider)}
          onSelectPreset={handleSelectPreset}
          onSelectCustom={handleSelectCustom}
          onSkip={handleSkipModelConfig}
        />
        {error && (
          <div role="alert" className="fixed bottom-8 left-4 right-4 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:max-w-md p-4 bg-destructive/10 border border-destructive/20 rounded-lg z-50 break-words">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}
      </>
    )
  }

  if (step === 'config' && configEntry) {
    return (
      <SetupProviderConfig
        entry={configEntry}
        onBack={handleBackFromConfig}
      />
    )
  }

  return null
}
