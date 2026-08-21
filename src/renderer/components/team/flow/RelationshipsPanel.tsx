/**
 * RelationshipsPanel — the authoritative relationship editor, floating over the
 * top-right of the canvas. Lists every link ("A → B", sync/async, delete) and
 * adds new ones via plain dropdowns. Every action is a visible control — this is
 * what a non-technical user reaches for; the canvas drag / node toolbar are
 * shortcuts onto the same operations.
 */

import { useContext, useMemo, useState } from 'react'
import { Plus, Trash2, ArrowDown, ChevronRight, Network, Star } from 'lucide-react'
import { FlowEditContext } from './flow-context'
import { useTranslation } from '../../../i18n'

export function RelationshipsPanel() {
  const { t } = useTranslation()
  const edit = useContext(FlowEditContext)
  const [collapsed, setCollapsed] = useState(false)
  const [adding, setAdding] = useState(false)

  const nameFor = useMemo(() => {
    const map = new Map((edit?.roster ?? []).map(m => [m.appId, m]))
    return (appId: string) => map.get(appId)
  }, [edit?.roster])

  if (!edit) return null
  const { roster, edges, removeRelation, setSync } = edit

  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-10 flex max-h-[calc(100%-1.5rem)] w-72 flex-col overflow-hidden rounded-xl border border-border bg-background/95 shadow-xl backdrop-blur">
      {/* Header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-left"
      >
        <Network className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{t('Relationships')}</span>
        <span className="rounded-full bg-secondary px-1.5 text-[11px] text-muted-foreground">{edges.length}</span>
        <ChevronRight className={`ml-auto h-4 w-4 text-muted-foreground transition-transform ${collapsed ? '' : 'rotate-90'}`} />
      </button>

      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* List */}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {edges.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground/70">
                {t('No relationships yet. Add one below, or drag between members.')}
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {edges.map((e, i) => {
                  const from = nameFor(e.fromAppId)
                  const to = nameFor(e.toAppId)
                  return (
                    <li key={`${e.fromAppId}-${e.toAppId}-${i}`} className="rounded-lg border border-border bg-background p-2">
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="flex min-w-0 items-center gap-1">
                          {from?.isLead && <Star className="h-3.5 w-3.5 flex-shrink-0 fill-current text-amber-500" />}
                          <span className="truncate text-foreground">{from?.memberName ?? e.fromAppId}</span>
                        </span>
                        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        <span className="flex min-w-0 items-center gap-1">
                          {to?.isLead && <Star className="h-3.5 w-3.5 flex-shrink-0 fill-current text-amber-500" />}
                          <span className="truncate text-foreground">{to?.memberName ?? e.toAppId}</span>
                        </span>
                        <button
                          onClick={() => removeRelation(e.fromAppId, e.toAppId)}
                          className="ml-auto flex-shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          title={t('Remove relationship')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <select
                        value={e.sync ? 'sync' : 'async'}
                        onChange={ev => setSync(e.fromAppId, e.toAppId, ev.target.value === 'sync')}
                        className="mt-1.5 w-full rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="async">{t('Async (no wait)')}</option>
                        <option value="sync">{t('Sync (waits for reply)')}</option>
                      </select>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {/* Add */}
          <div className="border-t border-border p-2">
            {adding ? (
              <AddRelationForm onClose={() => setAdding(false)} />
            ) : (
              <button
                onClick={() => setAdding(true)}
                disabled={roster.length < 2}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('Add relationship')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function AddRelationForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const edit = useContext(FlowEditContext)!
  const { roster, edges, addRelation } = edit

  const lead = roster.find(m => m.isLead)
  const firstOther = roster.find(m => !m.isLead)
  const [from, setFrom] = useState(lead?.appId ?? roster[0]?.appId ?? '')
  const [to, setTo] = useState(firstOther?.appId ?? roster[1]?.appId ?? '')
  const [sync, setSyncState] = useState(false)

  const sameNode = from === to
  const duplicate = !!from && !!to && edges.some(e => e.fromAppId === from && e.toAppId === to)
  const canAdd = !!from && !!to && !sameNode && !duplicate

  // The lead marker is the ★ character here, not the Star icon used everywhere
  // else: <option> takes text only, so an element child would not render.
  return (
    <div className="space-y-2">
      <div>
        <label className="mb-0.5 block text-[11px] text-muted-foreground">{t('From (can message)')}</label>
        <select value={from} onChange={e => setFrom(e.target.value)} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
          {roster.map(m => <option key={m.appId} value={m.appId}>{m.isLead ? `★ ${m.memberName}` : m.memberName}</option>)}
        </select>
      </div>
      <div className="flex justify-center text-muted-foreground"><ArrowDown className="h-4 w-4" /></div>
      <div>
        <label className="mb-0.5 block text-[11px] text-muted-foreground">{t('To (the recipient)')}</label>
        <select value={to} onChange={e => setTo(e.target.value)} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
          {roster.map(m => <option key={m.appId} value={m.appId}>{m.isLead ? `★ ${m.memberName}` : m.memberName}</option>)}
        </select>
      </div>
      <select value={sync ? 'sync' : 'async'} onChange={e => setSyncState(e.target.value === 'sync')} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
        <option value="async">{t('Async (no wait)')}</option>
        <option value="sync">{t('Sync (waits for reply)')}</option>
      </select>
      {sameNode && <p className="text-[11px] text-amber-600 dark:text-amber-400">{t('Pick two different members.')}</p>}
      {duplicate && <p className="text-[11px] text-amber-600 dark:text-amber-400">{t('This relationship already exists.')}</p>}
      <div className="flex gap-2">
        <button
          onClick={() => { if (canAdd) { addRelation(from, to, sync); onClose() } }}
          disabled={!canAdd}
          className="flex-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {t('Add')}
        </button>
        <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary">
          {t('Cancel')}
        </button>
      </div>
    </div>
  )
}
