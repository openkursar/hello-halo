/**
 * TeamInviteDialog — mint and share an invite link for an office.
 *
 * Failure text is people-centric: it points the user at the setting they may
 * need to flip, never at transport details.
 */

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Copy, Check, Loader2, RefreshCw, Link2 } from 'lucide-react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'

interface TeamInviteDialogProps {
  teamId: string
  onClose: () => void
}

interface InvitePayload {
  url: string
  jti: string
}

export function TeamInviteDialog({ teamId, onClose }: TeamInviteDialogProps) {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(true)
  const [invite, setInvite] = useState<InvitePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState(false)

  const generate = useCallback(async () => {
    setLoading(true)
    setError(null)
    setCopied(false)
    try {
      const res = await api.teamGenerateInvite(teamId)
      if (res.success && res.data) {
        const data = res.data as { url: string; jti: string }
        setInvite({ url: data.url, jti: data.jti })
      } else if (res.error === 'REMOTE_ACCESS_OFF') {
        setError(t('Turn on Remote Access in Settings so others can join this office.'))
      } else {
        setError(t('Could not create an invite. Please try again.'))
      }
    } catch {
      setError(t('Could not create an invite. Please try again.'))
    } finally {
      setLoading(false)
    }
  }, [teamId, t])

  useEffect(() => { void generate() }, [generate])

  const copyLink = async () => {
    if (!invite) return
    try {
      await navigator.clipboard.writeText(invite.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError(t('Could not copy the link. Select it and copy manually.'))
    }
  }

  const revoke = async () => {
    if (!invite) return
    setRevoking(true)
    try {
      await api.teamRevokeInvite(teamId, invite.jti)
      setInvite(null)
    } catch {
      // Non-fatal: the link still expires on its own.
    } finally {
      setRevoking(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4" onMouseDown={onClose}>
      <div
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-6">
          <h2 className="flex items-center gap-2 text-base font-medium text-foreground">
            <Link2 className="h-4 w-4 text-muted-foreground" />
            {t('Invite to this office')}
          </h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4 sm:px-6">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('Creating an invite link…')}
            </div>
          ) : error ? (
            <div className="space-y-3">
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-foreground">
                {error}
              </p>
              <button
                onClick={generate}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t('Try again')}
              </button>
            </div>
          ) : invite ? (
            <>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  readOnly
                  value={invite.url}
                  onFocus={e => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  onClick={copyLink}
                  className="inline-flex flex-shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? t('Copied') : t('Copy link')}
                </button>
              </div>

              <p className="text-xs text-muted-foreground">
                {t('Anyone with this link can bring a digital human into this office.')}
              </p>

              <div className="flex justify-end border-t border-border pt-3">
                <button
                  onClick={revoke}
                  disabled={revoking}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                >
                  {revoking && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t('Revoke this link')}
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-3 py-2">
              <p className="text-sm text-muted-foreground">{t('This link has been revoked.')}</p>
              <button
                onClick={generate}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t('Create a new link')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
