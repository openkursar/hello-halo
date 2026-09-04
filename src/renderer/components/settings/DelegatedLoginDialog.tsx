/**
 * Delegated Login Dialog
 *
 * Signs the bundled Claude Code CLI into Halo's own credential slot. The CLI
 * runs its own browser flow and keeps the resulting token, so nothing here
 * ever handles a credential — the dialog only starts the command, watches the
 * slot, and turns a completed login into an AI source.
 *
 * The command runs in a real terminal session rather than a hidden process
 * because the CLI's login is interactive: the user has to see its output and
 * complete the browser step.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Copy, Loader2, Terminal, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { useSpaceStore } from '../../stores/space.store'
import { useTerminalStore } from '../../stores/terminal.store'

export interface DelegatedLoginDialogProps {
  open: boolean
  onClose: () => void
  /** Called once the source has been created, with the signed-in account label. */
  onComplete: (account: string) => void | Promise<void>
}

interface DelegatedStatus {
  supported: boolean
  loggedIn: boolean
  account: string
  configDir: string
  loginCommand: string
}

/** Slow enough to stay invisible next to an interactive browser login. */
const POLL_INTERVAL_MS = 2000

export function DelegatedLoginDialog({ open, onClose, onComplete }: DelegatedLoginDialogProps) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<DelegatedStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [activating, setActivating] = useState(false)
  const spaceId = useSpaceStore(s => s.currentSpace?.id ?? null)
  const createSession = useTerminalStore(s => s.createSession)
  const openInCanvas = useTerminalStore(s => s.openInCanvas)
  // Guards the activation that the poll triggers, which would otherwise fire
  // again on the tick that lands before the dialog closes.
  const activatedRef = useRef(false)
  // Callers pass an inline callback; holding it in a ref keeps the poll effect
  // from tearing down and restarting its interval on every parent render.
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const readStatus = useCallback(async () => {
    const result = await api.authDelegatedStatus()
    if (result.success) setStatus(result.data as DelegatedStatus)
    return result.success ? (result.data as DelegatedStatus) : null
  }, [])

  const activate = useCallback(async () => {
    if (activatedRef.current) return
    activatedRef.current = true
    setActivating(true)
    try {
      const result = await api.authDelegatedActivate()
      if (!result.success) {
        activatedRef.current = false
        setError(result.error || t('Could not create the source'))
        return
      }
      const { account } = result.data as { account: string }
      await onCompleteRef.current(account)
    } finally {
      setActivating(false)
    }
  }, [t])

  useEffect(() => {
    if (!open) {
      activatedRef.current = false
      setStatus(null)
      setError(null)
      setCopied(false)
      return
    }

    let cancelled = false
    const tick = async () => {
      const next = await readStatus()
      if (cancelled || !next?.loggedIn) return
      void activate()
    }

    void tick()
    const timer = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [open, readStatus, activate])

  const handleRunInTerminal = async () => {
    if (!status?.loginCommand || !spaceId) return
    setError(null)
    const session = await createSession(spaceId)
    if (!session) {
      setError(t('Could not open a terminal session'))
      return
    }
    openInCanvas(session.id, t('Claude Code login'))
    await api.terminalInput(session.id, `${status.loginCommand}\n`)
  }

  const handleCopy = async () => {
    if (!status?.loginCommand) return
    await navigator.clipboard.writeText(status.loginCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg bg-card border border-border rounded-xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5 min-w-0">
            <Terminal className="w-5 h-5 text-primary flex-shrink-0" />
            <h2 className="text-base font-medium truncate">{t('Sign in with Claude Code CLI')}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-muted transition-colors flex-shrink-0"
            aria-label={t('Close')}
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="px-5 py-5 sm:px-6 space-y-4">
          {!status && (
            <div className="flex items-center gap-2 py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('Checking sign-in state...')}</span>
            </div>
          )}

          {status && !status.supported && (
            <p className="text-sm text-muted-foreground">
              {t('Delegated sign-in is only available on macOS in this version.')}
            </p>
          )}

          {status?.supported && status.loggedIn && (
            <div className="flex items-start gap-2.5 rounded-lg bg-primary/10 border border-primary/30 px-3 py-2.5">
              <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
              <div className="min-w-0 text-sm">
                <div className="font-medium">{t('Claude Code CLI is signed in')}</div>
                {status.account && (
                  <div className="text-muted-foreground truncate">{status.account}</div>
                )}
              </div>
            </div>
          )}

          {status?.supported && !status.loggedIn && (
            <>
              <p className="text-sm text-muted-foreground">
                {t('Run this command and complete the sign-in. Halo keeps no token — the CLI stores and refreshes its own credential.')}
              </p>

              <div className="rounded-lg border border-border bg-muted/50 px-3 py-2.5 overflow-x-auto">
                <code className="text-xs whitespace-pre text-foreground">{status.loginCommand}</code>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  onClick={handleRunInTerminal}
                  disabled={!spaceId}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                             bg-primary text-primary-foreground text-sm font-medium
                             hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  <Terminal className="w-4 h-4" />
                  {t('Run in Halo terminal')}
                </button>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                             border border-border text-sm hover:bg-muted transition-colors"
                >
                  <Copy className="w-4 h-4" />
                  {copied ? t('Copied') : t('Copy command')}
                </button>
              </div>

              <p className="text-xs text-muted-foreground">
                {t('This dialog activates the source automatically once the sign-in completes.')}
              </p>
            </>
          )}

          {activating && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('Creating the AI source...')}
            </div>
          )}

          {error && <p className="text-sm text-destructive break-words">{error}</p>}
        </div>
      </div>
    </div>
  )
}
