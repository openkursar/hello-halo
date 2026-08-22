/**
 * TeamJoinDialog — join an office hosted elsewhere by pasting an invite link.
 *
 * Brought-in digital humans stay yours; they simply show up in the other
 * office. Failure text is people-centric and never mentions hosts, nodes, or
 * networks.
 *
 * Entry points: manual paste, or one-click join — a halo:// deep link staged in
 * team.store pre-fills the link via `initialLink` (see TeamTabContent).
 */

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, Check, LogIn, Eye, Lock, Plus } from 'lucide-react'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'

interface TeamJoinDialogProps {
  onClose: () => void
  /** Open the create-digital-human flow when the user has none to bring. */
  onCreateDigitalHuman?: () => void
  /** Pre-filled invite link (one-click join via halo:// deep link). */
  initialLink?: string
}

interface ParsedInvite {
  officeId: string
  serverUrl: string
  inviteToken: string
}

function parseInviteLink(raw: string): ParsedInvite | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    const officeId = url.searchParams.get('office')
    const inviteToken = url.searchParams.get('invite')
    if (!officeId || !inviteToken) return null
    return { officeId, serverUrl: url.origin, inviteToken }
  } catch {
    return null
  }
}

export function TeamJoinDialog({ onClose, onCreateDigitalHuman, initialLink }: TeamJoinDialogProps) {
  const { t } = useTranslation()

  const apps = useAppsStore(s => s.apps)
  const loadApps = useAppsStore(s => s.loadApps)
  const teams = useTeamStore(s => s.teams)
  const loadTeams = useTeamStore(s => s.loadTeams)

  const [link, setLink] = useState(initialLink ?? '')
  const [selectedAppIds, setSelectedAppIds] = useState<string[]>([])
  const [consented, setConsented] = useState(false)
  const [joining, setJoining] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)

  useEffect(() => { void loadApps() }, [loadApps])

  const parsed = useMemo(() => parseInviteLink(link), [link])
  const linkError = submitted && link.trim().length > 0 && !parsed

  // Lead apps are an internal coordination role — never bring them as members.
  const leadAppIds = useMemo(
    () => new Set(teams.map(tm => tm.leadAppId).filter((id): id is string => !!id)),
    [teams],
  )

  const bringable = useMemo<InstalledApp[]>(
    () => apps.filter(a =>
      a.spec.type === 'automation' &&
      a.status !== 'uninstalled' &&
      !leadAppIds.has(a.id),
    ),
    [apps, leadAppIds],
  )

  const toggle = (appId: string) =>
    setSelectedAppIds(ids => ids.includes(appId) ? ids.filter(id => id !== appId) : [...ids, appId])

  const join = async () => {
    setSubmitted(true)
    setError(null)
    if (!parsed) {
      setError(t('That invite link is not valid.'))
      return
    }
    if (selectedAppIds.length === 0) {
      setError(t('Select at least one digital human to bring.'))
      return
    }
    if (!consented) {
      setError(t('Please confirm you understand what teammates will see.'))
      return
    }

    setJoining(true)
    try {
      const res = await api.teamJoinOffice({
        officeId: parsed.officeId,
        serverUrl: parsed.serverUrl,
        inviteToken: parsed.inviteToken,
        bringAppIds: selectedAppIds,
      })
      if (res.success) {
        await loadTeams()
        onClose()
        return
      }
      setError(joinErrorText(res.error, t))
    } catch {
      setError(joinErrorText(undefined, t))
    } finally {
      setJoining(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-6">
          <h2 className="flex items-center gap-2 text-base font-medium text-foreground">
            <LogIn className="h-4 w-4 text-muted-foreground" />
            {t('Join a team')}
          </h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('Invite link')}</label>
            <input
              type="text"
              value={link}
              onChange={e => setLink(e.target.value)}
              placeholder={t('Paste the invite link')}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/50"
            />
            {linkError && <p className="mt-1 text-xs text-destructive">{t('That invite link is not valid.')}</p>}
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('Bring your digital humans')}</p>
            {bringable.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center">
                <p className="text-sm text-muted-foreground/80">{t('You don\u2019t have a digital human yet — make one to bring along.')}</p>
                {onCreateDigitalHuman && (
                  <button
                    onClick={() => { onClose(); onCreateDigitalHuman() }}
                    className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('Create a digital human')}
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {bringable.map(app => {
                  const checked = selectedAppIds.includes(app.id)
                  return (
                    <button
                      key={app.id}
                      onClick={() => toggle(app.id)}
                      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                        checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/50'
                      }`}
                    >
                      <span className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                      }`}>
                        {checked && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">{app.spec.name}</span>
                        {app.spaceId && (
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">{app.spaceId}</span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {bringable.length > 0 && (
            <div className="rounded-lg border border-border bg-secondary/30 p-3.5">
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Eye className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                {t('What your teammates will see')}
              </p>
              <ul className="mt-2 space-y-1.5 pl-6 text-sm text-muted-foreground">
                <li className="list-disc">{t('Your digital human\u2019s thinking, as it works')}</li>
                <li className="list-disc">{t('The tools it reaches for')}</li>
                <li className="list-disc">{t('The names of files it produces')}</li>
              </ul>
              <p className="mt-2.5 flex items-start gap-2 text-xs text-muted-foreground">
                <Lock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
                {t('Your digital human keeps working in its own space on your side, and your files, keys, and computer stay private — only the items above are shared.')}
              </p>
              <label className="mt-3 flex cursor-pointer items-center gap-2.5 border-t border-border pt-3 text-sm text-foreground">
                <span className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                  consented ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                }`}>
                  {consented && <Check className="h-3 w-3" />}
                </span>
                <input
                  type="checkbox"
                  checked={consented}
                  onChange={e => setConsented(e.target.checked)}
                  className="sr-only"
                />
                {t('I understand, and I\u2019m happy to share this.')}
              </label>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-sm text-foreground">
              <p>{error}</p>
              <button
                onClick={() => setShowHelp(v => !v)}
                className="mt-1.5 text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
              >
                {showHelp ? t('Hide tips') : t('Having trouble joining?')}
              </button>
              {showHelp && (
                <ul className="mt-2 space-y-1.5 pl-5 text-xs text-muted-foreground">
                  <li className="list-disc">{t('Double-check the invite link was copied in full.')}</li>
                  <li className="list-disc">{t('Ask the person who invited you to keep their app open.')}</li>
                  <li className="list-disc">{t('Make sure your own internet connection is working.')}</li>
                  <li className="list-disc">{t('Invite links expire — if it\u2019s old, ask for a fresh one.')}</li>
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-6">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={join}
            disabled={joining}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {joining && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('Join')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Map a join failure to neutral, people-centric guidance. */
function joinErrorText(code: string | undefined, t: (k: string) => string): string {
  switch (code) {
    case 'DESKTOP_ONLY':
      return t('Joining a team is only available in the desktop app.')
    case 'NO_MEMBERS':
      return t('Select at least one digital human to bring.')
    case 'VERSION_INCOMPATIBLE':
      return t('Your Halo version is not compatible with the host. Update both apps to the latest version and try again.')
    case 'AUTH_REJECTED':
      return t('This invite is no longer valid — it may have expired, been revoked, or the team was closed. Ask for a new invite link.')
    default:
      return t('Could not join the team. Check the link and that the person who invited you is online.')
  }
}
