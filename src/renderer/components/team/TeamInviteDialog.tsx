/**
 * TeamInviteDialog — mint and share an invite link for an office.
 *
 * Failure text is people-centric: it points the user at the setting they may
 * need to flip, never at transport details.
 */

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Copy, Check, Loader2, RefreshCw, Link2 } from 'lucide-react'
import type { CapabilityPresetId } from '../../../shared/apps/capability-policy'
import { isRemoteMember } from '../../../shared/apps/team-types'
import { DelegationPresetPicker } from '../capability/DelegationPresetPicker'
import { api } from '../../api'
import { useTeamStore, detailOf } from '../../stores/team.store'
import { useAppsStore } from '../../stores/apps.store'
import { useTranslation } from '../../i18n'
import { presetOfDelegatedPolicy, withPreset } from './delegated-policy'
import { firstInviteSaver } from './first-invite'
import { inventoryOf, loadLendableItems } from './lendable-items'

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
  const [revokeError, setRevokeError] = useState<string | null>(null)

  // Handing out a link is also handing out reach into the digital humans
  // already in this office — the ones running on THIS computer. The question
  // belongs here, at the moment that reach is created, and it is applied to all
  // of them at once: nobody sets it per member before knowing who is joining.
  const detail = useTeamStore(s => detailOf(s, teamId))
  const updateMember = useTeamStore(s => s.updateMember)
  const localMembers = (detail?.team.id === teamId ? detail.members : []).filter(m => !isRemoteMember(m))
  // Read once, as the dialog opens: the link it creates is what makes the team
  // reach another computer, and that must not change what the dialog does.
  const [firstLink] = useState(() => detail?.crossesMachines === false)
  // A team already reached from elsewhere shows what is saved, and saves
  // nothing until an answer is clicked.
  const [preset, setPreset] = useState<CapabilityPresetId | null>(firstLink ? 'read_only' : null)
  const [differs, setDiffers] = useState(false)
  const [presetKnown, setPresetKnown] = useState(firstLink)
  const [applying, setApplying] = useState(false)

  const applyPreset = useCallback(async (next: CapabilityPresetId) => {
    setPreset(next)
    setDiffers(false)
    const members = (detailOf(useTeamStore.getState(), teamId)?.members ?? []).filter(m => !isRemoteMember(m))
    if (members.length === 0) return
    setApplying(true)
    try {
      await Promise.all(
        members.map(m => updateMember(teamId, m.appId, { delegatedPolicy: withPreset(m.delegatedPolicy, next) })),
      )
    } finally {
      setApplying(false)
    }
  }, [teamId, updateMember])

  useEffect(() => {
    if (firstLink) return
    let cancelled = false
    const members = (detailOf(useTeamStore.getState(), teamId)?.members ?? []).filter(m => !isRemoteMember(m))
    const apps = useAppsStore.getState().apps
    void Promise.all(members.map(async member => {
      const app = apps.find(a => a.id === member.appId)
      const items = app ? await loadLendableItems(app).catch(() => null) : null
      return presetOfDelegatedPolicy(member.delegatedPolicy, items ? inventoryOf(items) : undefined)
    })).then(presets => {
      if (cancelled) return
      const first = presets[0] ?? null
      const alike = first !== null && presets.every(p => p === first)
      setPreset(alike ? first : null)
      setDiffers(!alike)
      setPresetKnown(true)
    })
    return () => { cancelled = true }
  }, [firstLink, teamId])

  // The first link's answer is saved once a call that may create it returns,
  // even after the dialog closed (see first-invite.ts).
  const [settleFirstLink] = useState(() =>
    firstLink ? firstInviteSaver(() => { void applyPreset('read_only') }) : () => {},
  )

  const generate = useCallback(async () => {
    setLoading(true)
    setError(null)
    setCopied(false)
    setRevokeError(null)
    try {
      const res = await api.teamGenerateInvite(teamId)
      settleFirstLink(res)
      if (res.success && res.data) {
        const data = res.data as { url: string; jti: string }
        setInvite({ url: data.url, jti: data.jti })
      } else if (res.error === 'REMOTE_ACCESS_OFF') {
        setError(t('Turn on Remote Access in Settings so others can join this team.'))
      } else {
        setError(t('Could not create an invite. Please try again.'))
      }
    } catch {
      settleFirstLink(null)
      setError(t('Could not create an invite. Please try again.'))
    } finally {
      setLoading(false)
    }
  }, [teamId, t, settleFirstLink])

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
    setRevokeError(null)
    try {
      const res = await api.teamRevokeInvite(teamId, invite.jti)
      if (res.success) {
        setInvite(null)
      } else {
        setRevokeError(t('Could not revoke this link. Please try again.'))
      }
    } catch {
      setRevokeError(t('Could not revoke this link. Please try again.'))
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
            {t('Invite to this team')}
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
                {t('Anyone with this link can bring a digital human into this team.')}
              </p>

              {localMembers.length > 0 && presetKnown && (
                <div className="border-t border-border pt-3">
                  <DelegationPresetPicker
                    value={preset}
                    onChange={next => { void applyPreset(next) }}
                    title={t('What the people you invite can have your digital humans do')}
                    subtitle={t('Applies to every digital human of yours in this team. Talking to them yourself is unaffected.')}
                    notice={differs
                      ? t('Your digital humans here are set differently right now. Choosing an answer applies it to all of them.')
                      : undefined}
                  />
                  {applying && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {t('Saving…')}
                    </p>
                  )}
                </div>
              )}

              <div className="flex flex-col items-end gap-1.5 border-t border-border pt-3">
                {revokeError && <p className="text-xs text-destructive">{revokeError}</p>}
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
