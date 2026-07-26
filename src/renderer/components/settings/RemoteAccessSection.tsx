/**
 * Remote Access Section Component
 * Manages remote access and tunnel settings
 */

import { useState, useEffect } from 'react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { useSecurityPolicy } from '../../hooks/useSecurityPolicy'
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  checkPasswordPolicy,
  type PasswordPolicyCode,
} from '../../../shared/auth/password-policy'
import type { RemoteAccessStatus } from './types'

type TranslateFn = (text: string, options?: Record<string, unknown>) => string

/**
 * Map a failing policy result to a single, localized message. The
 * structural rules live in `shared/auth/password-policy` so this view
 * never drifts from the main-side enforcement; only the wording is
 * renderer-owned (because it must go through `t()`).
 */
function describePolicyFailure(codes: PasswordPolicyCode[], t: TranslateFn): string {
  const [first] = codes
  if (first === 'NOT_A_STRING') return t('Password is required')
  if (first === 'TOO_SHORT') {
    return t('Password must be at least {{min}} characters', { min: PASSWORD_MIN_LENGTH })
  }
  if (first === 'TOO_LONG') {
    return t('Password must be at most {{max}} characters', { max: PASSWORD_MAX_LENGTH })
  }

  const fragments: string[] = []
  if (codes.includes('MISSING_UPPER')) fragments.push(t('uppercase letter'))
  if (codes.includes('MISSING_LOWER')) fragments.push(t('lowercase letter'))
  if (codes.includes('MISSING_DIGIT')) fragments.push(t('digit'))
  return t('Password must include: {{items}}', { items: fragments.join(', ') })
}

export function RemoteAccessSection() {
  const { t } = useTranslation()

  // Build-time security policy. While `null` (first fetch in flight)
  // we keep the permissive default — the backend still enforces every
  // gate, this hook only controls UI visibility.
  const securityPolicy = useSecurityPolicy()
  const tunnelDisabledByPolicy = securityPolicy?.tunnelSafe === true

  // Remote access state
  const [remoteStatus, setRemoteStatus] = useState<RemoteAccessStatus | null>(null)
  const [isEnablingRemote, setIsEnablingRemote] = useState(false)
  const [isEnablingTunnel, setIsEnablingTunnel] = useState(false)
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [isEditingPassword, setIsEditingPassword] = useState(false)
  const [customPassword, setCustomPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [isSavingPassword, setIsSavingPassword] = useState(false)
  // Surfaced when the persisted credential could not be decoded. The
  // backend has already cleared the bad blob and disabled the feature, so
  // re-toggling will succeed with a fresh PIN; the message tells the user
  // why their previously paired devices stopped working.
  const [enableError, setEnableError] = useState<string | null>(null)

  // Change-address flow (revoke + re-issue a new permanent hostname)
  const [showReset, setShowReset] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  // Load remote access status
  useEffect(() => {
    loadRemoteStatus()

    const unsubscribe = api.onRemoteStatusChange((data) => {
      setRemoteStatus(data as RemoteAccessStatus)
    })

    return () => {
      unsubscribe()
    }
  }, [])

  // Load QR code only when the public tunnel is live — it encodes the
  // public URL, so without a tunnel there is nothing meaningful to scan.
  useEffect(() => {
    if (remoteStatus?.enabled && remoteStatus.tunnel.status === 'running') {
      loadQRCode()
    } else {
      setQrCode(null)
    }
  }, [remoteStatus?.enabled, remoteStatus?.tunnel.status, remoteStatus?.tunnel.url])

  const loadRemoteStatus = async () => {
    try {
      const response = await api.getRemoteStatus()
      if (response.success && response.data) {
        setRemoteStatus(response.data as RemoteAccessStatus)
      }
    } catch (error) {
      console.error('[RemoteAccessSection] loadRemoteStatus error:', error)
    }
  }

  const loadQRCode = async () => {
    const response = await api.getRemoteQRCode(false)
    if (response.success && response.data) {
      setQrCode((response.data as any).qrCode)
    }
  }

  const handleToggleRemote = async () => {
    if (remoteStatus?.enabled) {
      const response = await api.disableRemoteAccess()
      if (response.success) {
        setRemoteStatus(null)
        setQrCode(null)
        setEnableError(null)
      }
      return
    }
    setIsEnablingRemote(true)
    setEnableError(null)
    try {
      const response = await api.enableRemoteAccess()
      if (response.success && response.data) {
        setRemoteStatus(response.data as RemoteAccessStatus)
      } else if (response.code === 'CREDENTIAL_RESTORE_FAILED') {
        setEnableError(
          t(
            'Stored access credential could not be decoded and has been cleared. Toggle remote access on again to generate a new password, then re-pair your devices.',
          ),
        )
      } else {
        setEnableError(response.error || t('Failed to enable remote access'))
      }
    } catch (error) {
      setEnableError(t('Failed to enable remote access'))
    } finally {
      setIsEnablingRemote(false)
    }
  }

  const handleToggleTunnel = async () => {
    if (remoteStatus?.tunnel.status === 'running') {
      await api.disableTunnel()
    } else {
      setIsEnablingTunnel(true)
      try {
        await api.enableTunnel()
      } finally {
        setIsEnablingTunnel(false)
      }
    }
    loadRemoteStatus()
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const handleResetAddress = async () => {
    setIsResetting(true)
    setResetError(null)
    try {
      const response = await api.resetTunnelAddress()
      if (response.success) {
        setShowReset(false)
        loadRemoteStatus()
      } else if (response.code === 'ISSUER_RATE_LIMITED') {
        setResetError(t("Your network reached today's limit for address changes. Try again after the limit resets (within 24 hours)."))
      } else {
        setResetError(response.error || t('Failed to change address'))
      }
    } catch {
      setResetError(t('Failed to change address'))
    } finally {
      setIsResetting(false)
    }
  }

  return (
    <section id="remote" className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-medium mb-4">{t('Remote Access')}</h2>

      {/* Security Warning */}
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 mb-4">
        <div className="flex items-start gap-3">
          <span className="text-amber-500 text-xl">⚠️</span>
          <div className="text-sm">
            <p className="text-amber-500 font-medium mb-1">{t('Security Warning')}</p>
            <p className="text-amber-500/80">
              {t('After enabling remote access, anyone with the password can fully control your computer (read/write files, execute commands). Do not share the access password with untrusted people.')}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {/* Enable/Disable Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">{t('Enable Remote Access')}</p>
            <p className="text-sm text-muted-foreground">
              {t('Allow access to Halo from other devices')}
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={remoteStatus?.enabled || false}
              onChange={handleToggleRemote}
              disabled={isEnablingRemote}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
              <div
                className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                  remoteStatus?.enabled ? 'translate-x-5' : 'translate-x-0.5'
                } mt-0.5`}
              />
            </div>
          </label>
        </div>

        {enableError && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
            <p className="text-sm text-red-500">{enableError}</p>
          </div>
        )}

        {/* Remote Access Details */}
        {remoteStatus?.enabled && (
          <>
            {/* Local Access */}
            <div className="bg-secondary/50 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t('Local Address')}</span>
                <div className="flex items-center gap-2">
                  <code className="text-sm bg-background px-2 py-1 rounded">
                    {remoteStatus.server.localUrl}
                  </code>
                  <button
                    onClick={() => copyToClipboard(remoteStatus.server.localUrl || '')}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t('Copy')}
                  </button>
                </div>
              </div>

              {remoteStatus.server.lanUrl && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('LAN Address')}</span>
                  <div className="flex items-center gap-2">
                    <code className="text-sm bg-background px-2 py-1 rounded">
                      {remoteStatus.server.lanUrl}
                    </code>
                    <button
                      onClick={() => copyToClipboard(remoteStatus.server.lanUrl || '')}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      {t('Copy')}
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('Access Password')}</span>
                  {!isEditingPassword ? (
                    <div className="flex items-center gap-2">
                      <code className="text-sm bg-background px-2 py-1 rounded font-mono tracking-wider">
                        {showPassword ? remoteStatus.server.token : '••••••••'}
                      </code>
                      <button
                        onClick={() => setShowPassword(!showPassword)}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        {showPassword ? t('Hide') : t('Show')}
                      </button>
                      <button
                        onClick={() => copyToClipboard(remoteStatus.server.token || '')}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        {t('Copy')}
                      </button>
                      <button
                        onClick={() => {
                          setIsEditingPassword(true)
                          setCustomPassword('')
                          setPasswordError(null)
                        }}
                        className="text-xs text-primary hover:text-primary/80"
                      >
                        {t('Edit')}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={customPassword}
                        onChange={(e) => {
                          setCustomPassword(e.target.value)
                          setPasswordError(null)
                        }}
                        placeholder={t('8-64 chars, mixed case + digit')}
                        maxLength={PASSWORD_MAX_LENGTH}
                        className="w-56 px-2 py-1 text-sm bg-input rounded border border-border focus:border-primary focus:outline-none"
                      />
                      <button
                        onClick={async () => {
                          const policy = checkPasswordPolicy(customPassword)
                          if (!policy.ok) {
                            setPasswordError(describePolicyFailure(policy.codes, t))
                            return
                          }
                          setIsSavingPassword(true)
                          setPasswordError(null)
                          try {
                            const res = await api.setRemotePassword(customPassword)
                            if (res.success) {
                              setIsEditingPassword(false)
                              setCustomPassword('')
                              loadRemoteStatus()
                            } else {
                              setPasswordError(res.error || t('Failed to set password'))
                            }
                          } catch (error) {
                            setPasswordError(t('Failed to set password'))
                          } finally {
                            setIsSavingPassword(false)
                          }
                        }}
                        disabled={isSavingPassword || customPassword.length < PASSWORD_MIN_LENGTH}
                        className="text-xs px-2 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
                      >
                        {isSavingPassword ? t('Saving...') : t('Save')}
                      </button>
                      <button
                        onClick={() => {
                          setIsEditingPassword(false)
                          setCustomPassword('')
                          setPasswordError(null)
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        {t('Cancel')}
                      </button>
                    </div>
                  )}
                </div>
                {passwordError && (
                  <p className="text-xs text-red-500">{passwordError}</p>
                )}
              </div>

              {remoteStatus.clients > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t('Connected Devices')}</span>
                  <span className="text-green-500">{t('{{count}} devices', { count: remoteStatus.clients })}</span>
                </div>
              )}
            </div>

            {/* Tunnel Section — hidden entirely under security.tunnelSafe.
                Showing a permanently-off toggle would be dead UI and would
                misleadingly imply the user could turn the feature on. */}
            {!tunnelDisabledByPolicy && (
              <div className="pt-4 border-t border-border">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-medium">{t('Internet Access')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('Get a permanent public address for this device — it stays the same across restarts')}
                    </p>
                  </div>
                  <button
                    onClick={handleToggleTunnel}
                    disabled={isEnablingTunnel || remoteStatus.tunnel.status === 'starting'}
                    className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                      remoteStatus.tunnel.status === 'running'
                        ? 'bg-red-500/20 text-red-500 hover:bg-red-500/30'
                        : 'bg-primary/20 text-primary hover:bg-primary/30'
                    }`}
                  >
                    {isEnablingTunnel
                      ? t('Connecting...')
                      : remoteStatus.tunnel.status === 'running'
                        ? t('Stop Tunnel')
                        : remoteStatus.tunnel.status === 'starting'
                          ? t('Connecting...')
                          : t('Start Tunnel')}
                  </button>
                </div>

                {(remoteStatus.tunnel.status === 'running' ||
                  remoteStatus.tunnel.status === 'starting') &&
                  remoteStatus.tunnel.url && (
                  <div
                    className={`rounded-lg p-4 space-y-3 border ${
                      remoteStatus.tunnel.status === 'running'
                        ? 'bg-green-500/10 border-green-500/30'
                        : 'bg-secondary/50 border-border'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <span
                        className={`text-sm ${
                          remoteStatus.tunnel.status === 'running' ? 'text-green-500' : 'text-muted-foreground'
                        }`}
                      >
                        {remoteStatus.tunnel.mode === 'named'
                          ? t('Permanent Address')
                          : t('Public Address')}
                        {remoteStatus.tunnel.status === 'starting' && (
                          <span className="ml-2 text-xs text-amber-500 animate-pulse">
                            {t('Connecting...')}
                          </span>
                        )}
                      </span>
                      <div className="flex items-center gap-2 min-w-0">
                        <code
                          className={`text-sm bg-background px-2 py-1 rounded truncate ${
                            remoteStatus.tunnel.status === 'running' ? 'text-green-500' : 'text-foreground'
                          }`}
                        >
                          {remoteStatus.tunnel.url}
                        </code>
                        <button
                          onClick={() => copyToClipboard(remoteStatus.tunnel.url || '')}
                          className="text-xs text-muted-foreground hover:text-foreground shrink-0"
                        >
                          {t('Copy')}
                        </button>
                      </div>
                    </div>
                    {remoteStatus.tunnel.status === 'starting' ? (
                      <p className="text-xs text-muted-foreground">
                        {t('Your address is ready — establishing the connection, usually a few seconds.')}
                      </p>
                    ) : remoteStatus.tunnel.mode === 'named' ? (
                      <p className="text-xs text-muted-foreground">
                        {t('This address is permanently bound to this device and restores automatically after restarts.')}
                      </p>
                    ) : (
                      <p className="text-xs text-amber-500">
                        {remoteStatus.tunnel.fallbackReason === 'issuer_rate_limited'
                          ? t("Temporary address — your network reached today's limit for permanent-address requests. This is a product limit, not an error. Your permanent address will be restored automatically after the limit resets (within 24 hours).")
                          : remoteStatus.tunnel.fallbackReason === 'issuer_rejected'
                            ? t('Temporary address — this device identity was rejected by the address service.')
                            : t('Temporary address — the issuing service was unreachable, so this link changes on every restart. It will switch back to your permanent address automatically next time.')}
                      </p>
                    )}
                  </div>
                )}

                {remoteStatus.tunnel.status === 'error' && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                    <p className="text-sm text-red-500">
                      {t('Tunnel connection failed')}: {remoteStatus.tunnel.error}
                    </p>
                  </div>
                )}

                {/* Address management */}
                <div className="mt-4">
                  <button
                    onClick={() => {
                      setShowReset(!showReset)
                      setResetError(null)
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                  >
                    {t('Change address')}
                  </button>

                  {showReset && (
                    <div className="mt-3 bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 space-y-3">
                      <p className="text-sm text-amber-500">
                        {t('Get a new permanent address for this device. The current address stops working immediately and cannot be reclaimed — update any bookmarks or integrations that use it.')}
                      </p>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={handleResetAddress}
                          disabled={isResetting}
                          className="text-xs px-3 py-1.5 bg-amber-500/20 text-amber-500 rounded hover:bg-amber-500/30 disabled:opacity-50"
                        >
                          {isResetting ? t('Changing...') : t('Confirm and change address')}
                        </button>
                        <button
                          onClick={() => setShowReset(false)}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          {t('Cancel')}
                        </button>
                      </div>
                      {resetError && <p className="text-xs text-red-500">{resetError}</p>}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* QR Code */}
            {qrCode && (
              <div className="pt-4 border-t border-border">
                <p className="font-medium mb-3">{t('Scan to Access')}</p>
                <div className="flex flex-col items-center gap-3">
                  <div className="bg-white p-3 rounded-xl">
                    <img src={qrCode} alt="QR Code" className="w-48 h-48" />
                  </div>
                  <div className="text-center text-sm">
                    <p className="text-muted-foreground">
                      {t('Scan with your phone to open your address — works on any network')}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
