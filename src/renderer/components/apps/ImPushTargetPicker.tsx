/**
 * ImPushTargetPicker
 *
 * Adds IM chats another digital human's bot already knows to this digital
 * human's push targets, so it can push there without the chat ever messaging
 * it. Replies in those chats still go to the digital human the bot answers for.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search, User, Users, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { ImChannelInstanceStatus, ImSessionRecord } from '../../../shared/types/im-channel'
import { getImSessionDisplayName } from '../../../shared/types/im-channel'
import { pushTargetCandidates } from './im-push-targets'
import { getImChannelDisplay } from './im-channel-labels'

interface ImPushTargetPickerProps {
  appId: string
  onClose: () => void
  /** At least one chat was added */
  onAdded: () => void
}

const keyOf = (session: ImSessionRecord) => `${session.appId}:${session.channel}:${session.chatId}`

export function ImPushTargetPicker({ appId, onClose, onAdded }: ImPushTargetPickerProps) {
  const { t } = useTranslation()
  const [candidates, setCandidates] = useState<ImSessionRecord[] | null>(null)
  const [bots, setBots] = useState<ImChannelInstanceStatus[]>([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.imSessionsList() as Promise<{ success: boolean; data?: ImSessionRecord[] }>,
      api.imChannelsStatus() as Promise<{ success: boolean; data?: ImChannelInstanceStatus[] }>,
    ]).then(([sessionsRes, statusRes]) => {
      if (cancelled) return
      const statuses = statusRes.success && statusRes.data ? statusRes.data : []
      setBots(statuses)
      setCandidates(sessionsRes.success && sessionsRes.data ? pushTargetCandidates(sessionsRes.data, appId, statuses) : [])
    }).catch((err) => {
      console.warn('[ImPushTargetPicker] Could not load chats', err)
      if (!cancelled) setCandidates([])
    })
    return () => { cancelled = true }
  }, [appId])

  const requestClose = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  const botNames = useMemo(() => new Map(bots.map(bot => [bot.id, bot.appName])), [bots])

  const q = query.trim().toLowerCase()
  const shown = (candidates ?? []).filter(session =>
    !q || getImSessionDisplayName(session).toLowerCase().includes(q) || session.chatId.toLowerCase().includes(q)
  )

  const toggle = (session: ImSessionRecord) => {
    setSelected(prev => {
      const next = new Set(prev)
      const key = keyOf(session)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleAdd = async () => {
    const chosen = (candidates ?? []).filter(session => selected.has(keyOf(session)))
    if (chosen.length === 0) return
    setBusy(true)
    setError(null)
    let failed = 0
    for (const session of chosen) {
      try {
        const res = await api.imSessionsSetPushLink({
          appId,
          session: { appId: session.appId, channel: session.channel, chatId: session.chatId },
          link: { autoSync: false },
        })
        if (!res.success) failed++
      } catch {
        failed++
      }
    }
    setBusy(false)
    if (failed < chosen.length) onAdded()
    if (failed > 0) {
      console.warn('[ImPushTargetPicker] Some chats were not added', { failed, total: chosen.length })
      setError(t('Could not add {{count}} chat(s); they may have been removed meanwhile.', { count: failed }))
      return
    }
    onClose()
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('Add from existing chats')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30"
      onClick={requestClose}
    >
      <div
        className="bg-background border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-4 pt-4">
          <div className="space-y-1">
            <h2 className="text-sm font-medium text-foreground">{t('Add from existing chats')}</h2>
            <p className="text-xs text-muted-foreground">
              {t('Chats your other bots already know. This digital human can push to the ones you pick; replies there still go to the digital human the bot answers for.')}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
            title={t('Close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 pt-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Search chats')}
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-secondary border border-border rounded-lg outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-1.5">
          {candidates === null ? (
            <p className="text-sm text-muted-foreground text-center py-6">{t('Loading...')}</p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {t('No other chats yet. A chat shows up here once it has messaged one of your bots.')}
            </p>
          ) : shown.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">{t('No chats match "{{query}}"', { query })}</p>
          ) : (
            shown.map((session) => {
              const key = keyOf(session)
              const channel = getImChannelDisplay(session.channel)
              const answeredBy = botNames.get(session.instanceId)
              return (
                <label
                  key={key}
                  className="flex items-start gap-2.5 p-2.5 rounded-lg bg-muted/50 hover:bg-muted/70 transition-colors cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    onChange={() => toggle(session)}
                    className="mt-0.5 w-3.5 h-3.5 rounded border-border accent-primary cursor-pointer"
                  />
                  {session.chatType === 'group'
                    ? <Users className="w-4 h-4 mt-px text-muted-foreground shrink-0" />
                    : <User className="w-4 h-4 mt-px text-muted-foreground shrink-0" />}
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{getImSessionDisplayName(session)}</span>
                      <span className={`text-xs shrink-0 ${channel.color}`}>{channel.label}</span>
                    </span>
                    <span className="block text-xs text-muted-foreground/70 mt-0.5">
                      {answeredBy
                        ? t('Replies go to {{name}}', { name: answeredBy })
                        : (session.chatType === 'group' ? t('Group') : t('Direct'))}
                    </span>
                  </span>
                </label>
              )
            })
          )}
        </div>

        {error && <p className="px-4 pb-2 text-xs text-destructive">{error}</p>}

        <div className="flex items-center justify-end gap-2 px-4 pb-4 pt-1 border-t border-border/50">
          <button
            type="button"
            onClick={requestClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          >
            {t('Cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={busy || selected.size === 0}
            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {t('Add ({{count}})', { count: selected.size })}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
