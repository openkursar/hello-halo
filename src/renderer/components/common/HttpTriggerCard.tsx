/**
 * Collapsible card exposing the external HTTP trigger endpoint for a digital
 * human (`POST /api/apps/:id/trigger`) or team (`POST /api/teams/:id/run`).
 * Auth reuses the Remote Access password as `Authorization: Bearer`.
 */

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Copy, Check, Terminal, AlertTriangle, Info } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { useAppStore } from '../../stores/app.store'
import { cn } from '../../lib/utils'
import type { RemoteAccessStatus } from '../settings/types'

type TriggerKind = 'app' | 'team'

interface HttpTriggerCardProps {
  /** Which entity this card triggers. */
  kind: TriggerKind
  /** The entity id (appId or teamId). */
  id: string
}

interface BaseOption {
  id: 'local' | 'lan' | 'internet'
  label: string
  url: string
}

/** Navigate to Settings and scroll to the Remote Access section. */
function openRemoteSettings() {
  useAppStore.getState().setView('settings')
  // The settings page renders all sections in one scroll container; defer the
  // scroll until after the view switch has mounted the target section.
  setTimeout(() => {
    document.getElementById('remote')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, 100)
}

export function HttpTriggerCard({ kind, id }: HttpTriggerCardProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [copied, setCopied] = useState<'curl' | 'endpoint' | null>(null)
  const [baseId, setBaseId] = useState<BaseOption['id'] | null>(null)

  const isRemoteMode = api.isRemoteMode()

  // Load remote status lazily on first expand, then keep it fresh while open.
  useEffect(() => {
    if (!expanded || isRemoteMode) return
    let cancelled = false
    void api.getRemoteStatus().then((res) => {
      if (cancelled) return
      if (res.success && res.data) setStatus(res.data as RemoteAccessStatus)
      setLoaded(true)
    })
    const unsubscribe = api.onRemoteStatusChange((data) => {
      setStatus(data as RemoteAccessStatus)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [expanded, isRemoteMode])

  const path = kind === 'app' ? `/api/apps/${id}/trigger` : `/api/teams/${id}/run`

  const bases = useMemo<BaseOption[]>(() => {
    const server = status?.server
    const opts: BaseOption[] = []
    if (server?.localUrl) opts.push({ id: 'local', label: t('Local'), url: server.localUrl })
    else if (server?.port) opts.push({ id: 'local', label: t('Local'), url: `http://127.0.0.1:${server.port}` })
    if (server?.lanUrl) opts.push({ id: 'lan', label: t('LAN'), url: server.lanUrl })
    if (status?.tunnel.status === 'running' && status.tunnel.url) {
      opts.push({ id: 'internet', label: t('Internet'), url: status.tunnel.url })
    }
    return opts
  }, [status, t])

  const selectedBase = bases.find((b) => b.id === baseId) ?? bases[0] ?? null
  const token = status?.server.token ?? null
  const ready = !!(status?.enabled && status.server.running && token && selectedBase)

  const endpoint = selectedBase ? `${selectedBase.url}${path}` : path
  const curl = `curl -X POST \\\n  ${endpoint} \\\n  -H "Authorization: Bearer ${token ?? ''}"`

  const subtitle =
    kind === 'app'
      ? t('Trigger this digital human via an HTTP request')
      : t('Start a run of this team via an HTTP request')

  function copy(text: string, key: 'curl' | 'endpoint') {
    void navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
  }

  return (
    <div>
      {/* Accordion header — matches the uppercase muted section-title style. */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={expanded}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Terminal className="h-3.5 w-3.5 flex-shrink-0" />
            {t('HTTP Trigger')}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground/70">{subtitle}</p>
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded && (
        <div className="mt-3">
          {isRemoteMode ? (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-px h-3.5 w-3.5 flex-shrink-0" />
              {t('Open the desktop app to view and copy the HTTP trigger command.')}
            </p>
          ) : !loaded ? (
            <p className="text-xs text-muted-foreground">{t('Loading…')}</p>
          ) : !ready ? (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="flex items-start gap-1.5 text-xs text-amber-500">
                <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
                {t('Remote Access is off. Enable it to trigger this over HTTP from other devices.')}
              </p>
              <button
                onClick={openRemoteSettings}
                className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-opacity hover:opacity-90"
              >
                {t('Enable Remote Access')}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Base address selector — options appear only when reachable. */}
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs text-muted-foreground">{t('Base address')}</span>
                <select
                  value={selectedBase?.id}
                  onChange={(e) => setBaseId(e.target.value as BaseOption['id'])}
                  className="w-full rounded-md border border-border bg-secondary px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary sm:w-auto sm:max-w-[60%]"
                >
                  {bases.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label} · {b.url}
                    </option>
                  ))}
                </select>
              </div>

              {/* Primary action: a complete, copy-and-run curl command. The
                  endpoint and Bearer token are already embedded, so a separate
                  details panel would only duplicate them — we offer just an
                  endpoint-only copy for non-curl integrations. */}
              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">{t('Copy a ready-to-run command')}</span>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-secondary p-3 font-mono text-xs text-foreground">
                  {curl}
                </pre>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    onClick={() => copy(curl, 'curl')}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:w-auto"
                  >
                    {copied === 'curl' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied === 'curl' ? t('Copied') : t('Copy curl')}
                  </button>
                  <button
                    onClick={() => copy(endpoint, 'endpoint')}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:w-auto"
                  >
                    {copied === 'endpoint' ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied === 'endpoint' ? t('Copied') : t('Copy endpoint URL')}
                  </button>
                </div>
              </div>

              {/* Reachability note + deep link to Remote Access. */}
              <p className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] text-muted-foreground/70">
                <Info className="h-3 w-3 flex-shrink-0" />
                {t('Reachable from other devices only while Remote Access is on.')}
                <button onClick={openRemoteSettings} className="text-primary transition-opacity hover:opacity-80">
                  {t('Remote Access settings')}
                </button>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
