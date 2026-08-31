/**
 * ServerConnect - Connection flow for adding a Halo server (Capacitor mobile app).
 *
 * Allows the user to:
 * 1. Enter a Halo server URL manually
 * 2. Scan a QR code from the desktop app
 * 3. Enter the access code (PIN) to authenticate
 *
 * On success, calls onServerAdded with the connected server info (url, token, name)
 * so the caller can persist it to the server store.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Wifi, QrCode, ArrowRight, Loader2, AlertCircle, X, Server, ArrowLeft } from 'lucide-react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { isAccessCodeSubmittable, normalizeAccessCodeInput } from '../../../shared/auth/password-policy'

/** Info returned to the caller after a successful connection */
export interface ServerAddedInfo {
  url: string
  token: string
  name: string
}

interface ServerConnectProps {
  /** Called after successful connection with server info */
  onServerAdded: (info: ServerAddedInfo) => void
  /** Optional: show a back button to return to server list */
  onBack?: () => void
}

type ConnectStep = 'server' | 'auth' | 'scanning'

export function ServerConnect({ onServerAdded, onBack }: ServerConnectProps) {
  const { t } = useTranslation()

  const [step, setStep] = useState<ConnectStep>('server')
  const [serverUrl, setServerUrl] = useState('')
  const [serverName, setServerName] = useState('')
  const [accessCode, setAccessCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isScanning, setIsScanning] = useState(false)

  const scannerRef = useRef<any>(null)
  const scannerContainerRef = useRef<HTMLDivElement>(null)
  // Tracks whether the component is still mounted; prevents setState calls
  // on an already-unmounted component after async QR operations complete.
  const mountedRef = useRef(true)

  // Cleanup QR scanner on unmount
  useEffect(() => {
    return () => {
      mountedRef.current = false
      stopScanner()
    }
  }, [])

  const stopScanner = useCallback(() => {
    if (scannerRef.current) {
      try {
        scannerRef.current.stop().catch(() => {})
        scannerRef.current.clear()
      } catch {
        // ignore cleanup errors
      }
      scannerRef.current = null
    }
    setIsScanning(false)
  }, [])

  // Validate server URL format
  const isValidUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  }

  // Try to reach the server and derive a display name from its URL
  const fetchServerName = async (url: string): Promise<string> => {
    try {
      // Use the public status endpoint (no auth required) just to confirm reachability.
      // The status response does not include a server name, so we always fall through
      // to the URL-based fallback below.
      await fetch(`${url}/api/remote/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      })
    } catch {
      // Ignore — we'll use IP/hostname from URL as fallback
    }
    // Derive display name from URL host
    try {
      const parsed = new URL(url)
      return parsed.hostname
    } catch {
      return url
    }
  }

  // Step 1: Verify server is reachable
  const handleServerSubmit = async () => {
    let url = serverUrl.trim()
    if (!url) return

    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`
      setServerUrl(url)
    }

    if (!isValidUrl(url)) {
      setError(t('Invalid URL format'))
      return
    }

    setError(null)
    setIsConnecting(true)
    console.log(`[ServerConnect] Checking server: ${url}`)

    try {
      // Test connectivity via the public status endpoint (no auth required)
      const response = await fetch(`${url}/api/remote/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(10000)
      })

      if (response.ok) {
        console.log('[ServerConnect] Server reachable, proceeding to auth')
        api.setServerUrl(url)

        // Status endpoint does not expose a server name; derive it from the URL host
        setServerName(new URL(url).hostname)

        setStep('auth')
      } else {
        console.warn(`[ServerConnect] Server returned ${response.status}`)
        setError(t('Server is not responding correctly'))
      }
    } catch (err) {
      console.error('[ServerConnect] Connection failed:', err)
      setError(t('Cannot connect to server. Check the address and make sure Halo is running.'))
    } finally {
      setIsConnecting(false)
    }
  }

  // Complete connection — called after successful auth
  const completeConnection = (url: string, token: string, name: string) => {
    console.log(`[ServerConnect] Connection complete: ${name} (${url})`)
    onServerAdded({ url, token, name })
  }

  // Step 2: Authenticate with access code
  const handleAuth = async () => {
    const code = accessCode.trim()
    if (!code) return

    setError(null)
    setIsConnecting(true)
    console.log('[ServerConnect] Authenticating...')

    try {
      const result = await api.login(code)

      if (result.success) {
        console.log('[ServerConnect] Authentication successful')
        const name = serverName || await fetchServerName(serverUrl)
        completeConnection(serverUrl, code, name)
      } else {
        console.warn('[ServerConnect] Auth failed:', result.error)
        setError(result.error || t('Invalid access code'))
      }
    } catch (err) {
      console.error('[ServerConnect] Auth error:', err)
      setError(t('Authentication failed'))
    } finally {
      setIsConnecting(false)
    }
  }

  // QR code scanning
  const startScanner = async () => {
    setError(null)
    setStep('scanning')
    setIsScanning(true)

    // Dynamically import html5-qrcode to keep the initial bundle smaller
    try {
      const { Html5Qrcode } = await import('html5-qrcode')

      // Small delay to let the DOM container mount
      await new Promise(resolve => setTimeout(resolve, 100))

      if (!scannerContainerRef.current) {
        console.error('[ServerConnect] Scanner container not found')
        setIsScanning(false)
        setStep('server')
        return
      }

      const scanner = new Html5Qrcode('qr-scanner-container')
      scannerRef.current = scanner

      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
          aspectRatio: 1
        },
        (decodedText) => {
          console.log('[ServerConnect] QR scanned:', decodedText)
          handleQrResult(decodedText)
          stopScanner()
        },
        () => {
          // Scan failure (no QR found in frame) — expected, ignore
        }
      )
    } catch (err) {
      console.error('[ServerConnect] Scanner start failed:', err)
      setError(t('Camera access denied or not available'))
      setIsScanning(false)
      setStep('server')
    }
  }

  // Parse QR code result - expected format: halo://<url>?code=<access_code>
  // or just a plain URL
  const handleQrResult = async (text: string) => {
    console.log('[ServerConnect] Processing QR result:', text)

    let url: string
    let code: string | null = null

    if (text.startsWith('halo://')) {
      // Parse halo:// protocol
      const withoutProto = text.replace('halo://', 'http://')
      try {
        const parsed = new URL(withoutProto)
        code = parsed.searchParams.get('code')
        parsed.searchParams.delete('code')
        url = parsed.origin + parsed.pathname.replace(/\/$/, '')
      } catch {
        setError(t('Invalid QR code'))
        setStep('server')
        return
      }
    } else if (text.startsWith('http://') || text.startsWith('https://')) {
      try {
        const parsed = new URL(text)
        code = parsed.searchParams.get('code')
        parsed.searchParams.delete('code')
        url = parsed.origin + parsed.pathname.replace(/\/$/, '')
      } catch {
        setError(t('Invalid QR code'))
        setStep('server')
        return
      }
    } else {
      setError(t('Invalid QR code'))
      setStep('server')
      return
    }

    setServerUrl(url)
    api.setServerUrl(url)

    // Fetch server name — guard every post-await setState against unmount
    const name = await fetchServerName(url)
    if (!mountedRef.current) return
    setServerName(name)

    if (code) {
      // Auto-authenticate
      setAccessCode(code)
      setStep('auth')
      setIsConnecting(true)

      try {
        const result = await api.login(code)
        if (!mountedRef.current) return
        if (result.success) {
          console.log('[ServerConnect] QR auth successful')
          completeConnection(url, code, name)
        } else {
          setError(result.error || t('Invalid access code'))
          setIsConnecting(false)
        }
      } catch {
        if (!mountedRef.current) return
        setError(t('Authentication failed'))
        setIsConnecting(false)
      }
    } else {
      setStep('auth')
    }
  }

  // Handle Enter key in inputs
  const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter' && !isConnecting) {
      action()
    }
  }

  return (
    <div className="h-full w-full flex flex-col bg-background">
      {/* Safe area top padding handled by globals.css */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-8">
        {/* Back button (when coming from server list) */}
        {onBack && (
          <div className="absolute top-0 left-0 p-4 safe-area-top" style={{ paddingTop: 'max(16px, var(--sat))' }}>
            <button
              onClick={onBack}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              {t('Back')}
            </button>
          </div>
        )}

        {/* Logo / Brand */}
        <div className="mb-8 flex flex-col items-center">
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full border-2 border-primary/40 flex items-center justify-center mb-4 halo-breathe">
            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-primary/20" />
          </div>
          <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
            Halo
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {onBack ? t('Add a new device') : t('Connect to your desktop')}
          </p>
        </div>

        {/* QR Scanner view */}
        {step === 'scanning' && (
          <div className="w-full max-w-sm animate-fade-in">
            <div className="relative">
              <div
                id="qr-scanner-container"
                ref={scannerContainerRef}
                className="w-full aspect-square rounded-lg overflow-hidden bg-card border border-border"
              />
              <button
                onClick={() => {
                  stopScanner()
                  setStep('server')
                }}
                className="absolute top-3 right-3 p-2 rounded-full bg-background/80 text-foreground hover:bg-background transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-center text-sm text-muted-foreground mt-4">
              {t('Point your camera at the QR code on your desktop Halo')}
            </p>
          </div>
        )}

        {/* Step 1: Server URL */}
        {step === 'server' && (
          <div className="w-full max-w-sm space-y-4 animate-fade-in">
            {/* Server URL input */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t('Server address')}
              </label>
              <div className="relative">
                <Server className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(e) => {
                    setServerUrl(e.target.value)
                    setError(null)
                  }}
                  onKeyDown={(e) => handleKeyDown(e, handleServerSubmit)}
                  placeholder="192.168.1.100:3456"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="url"
                  className="w-full pl-10 pr-4 py-3 rounded-lg bg-card border border-border text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 text-base"
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                {t('Find this in Halo desktop → Settings → Remote Access')}
              </p>
            </div>

            {/* Connect button */}
            <button
              onClick={handleServerSubmit}
              disabled={!serverUrl.trim() || isConnecting}
              className="w-full py-3 rounded-lg bg-primary text-primary-foreground font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {isConnecting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Wifi className="w-4 h-4" />
              )}
              {isConnecting ? t('Connecting...') : t('Connect')}
            </button>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground">{t('or')}</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* QR scan button */}
            <button
              onClick={startScanner}
              className="w-full py-3 rounded-lg border border-border bg-card text-foreground font-medium flex items-center justify-center gap-2 hover:bg-secondary/50 transition-colors"
            >
              <QrCode className="w-4 h-4" />
              {t('Scan QR Code')}
            </button>
          </div>
        )}

        {/* Step 2: Access code */}
        {step === 'auth' && (
          <div className="w-full max-w-sm space-y-4 animate-fade-in">
            {/* Connection status */}
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card border border-border">
              <div className="w-2 h-2 rounded-full bg-halo-success" />
              <span className="text-sm text-foreground truncate flex-1">{serverUrl}</span>
              <button
                onClick={() => {
                  setStep('server')
                  setAccessCode('')
                  setError(null)
                }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('Change')}
              </button>
            </div>

            {/* Access code input */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t('Access code')}
              </label>
              <input
                type="text"
                value={accessCode}
                onChange={(e) => {
                  // Shared policy: auto PINs contain printable ASCII specials, so
                  // only whitespace is stripped — never characters.
                  setAccessCode(normalizeAccessCodeInput(e.target.value))
                  setError(null)
                }}
                onKeyDown={(e) => handleKeyDown(e, handleAuth)}
                placeholder={t('PIN or password')}
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                className="w-full px-4 py-3 rounded-lg bg-card border border-border text-foreground text-center text-lg font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50"
              />
              <p className="text-xs text-muted-foreground mt-1.5">
                {t('Enter the PIN or password shown on your desktop Halo')}
              </p>
            </div>

            {/* Login button */}
            <button
              onClick={handleAuth}
              disabled={!isAccessCodeSubmittable(accessCode) || isConnecting}
              className="w-full py-3 rounded-lg bg-primary text-primary-foreground font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {isConnecting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowRight className="w-4 h-4" />
              )}
              {isConnecting ? t('Verifying...') : t('Continue')}
            </button>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="w-full max-w-sm mt-4 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-destructive/10 border border-destructive/20 animate-fade-in">
            <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-6 pb-6 text-center">
        <p className="text-xs text-muted-foreground/50">
          {t('Make sure Halo is running on your computer with Remote Access enabled')}
        </p>
      </div>
    </div>
  )
}
