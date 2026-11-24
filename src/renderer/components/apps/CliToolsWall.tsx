/**
 * Command-line tools — the capability library's local view of the CLI tools
 * on this device, from every source: shipped with Halo, the enterprise
 * catalog, packages the user imported, and programs already on the computer.
 *
 * It works without the enterprise store: everything here reads the local
 * tool store. The only store call is "Update", which the user confirms.
 * Every change affects tasks started afterwards; running tasks keep the
 * command view they were started with (see services/cli-tools/DESIGN.md).
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, FilePlus2, Loader2, PackagePlus, ShieldOff, SquareTerminal } from 'lucide-react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { useNotificationStore } from '../../stores/notification.store'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { CliImportDialog, CliExternalDialog } from './CliToolDialogs'
import { cliToolsErrorText, skillSourceLabel, sourceLabel, statusClass, statusLabel } from './cli-tools-labels'
import type { RpcResponse } from '../../../shared/rpc/define'
import type {
  CliExternalPick, CliPackagePreviewView, CliToolsErrorCode, CliToolsOverview, CliToolsResult, CliToolVersionView, CliToolView,
} from '../../../shared/types/cli-tools'

/** Flatten the transport envelope into the action's own result. */
async function call<T>(request: Promise<RpcResponse<CliToolsResult<T>>>): Promise<CliToolsResult<T>> {
  const res = await request
  if (res.success && res.data) return res.data
  return { ok: false, code: 'UNEXPECTED', message: res.error ?? '' }
}

type Pending =
  | { kind: 'remove-version'; tool: CliToolView; version: CliToolVersionView }
  | { kind: 'remove-tool'; tool: CliToolView }
  | { kind: 'update'; tool: CliToolView; version: string }

export function CliToolsWall() {
  const { t } = useTranslation()
  const showToast = useNotificationStore(s => s.show)
  const [overview, setOverview] = useState<CliToolsOverview | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [preview, setPreview] = useState<CliPackagePreviewView | null>(null)
  const [externalPick, setExternalPick] = useState<CliExternalPick | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.cliToolsOverview()
      if (!res.success || !res.data) throw new Error(res.error)
      setOverview(res.data)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const fail = useCallback((code: CliToolsErrorCode, message: string) => {
    showToast({ title: cliToolsErrorText(t, code, message), variant: 'error', duration: 6000 })
  }, [showToast, t])

  /** Run an action that answers the new overview; report a refusal. */
  const run = useCallback(async (action: () => Promise<CliToolsResult<CliToolsOverview>>, done?: string) => {
    setBusy(true)
    try {
      const res = await action()
      if (res.ok) {
        setOverview(res.data)
        if (done) showToast({ title: done, variant: 'success', duration: 4000 })
      } else {
        fail(res.code, res.message)
      }
      return res.ok
    } finally {
      setBusy(false)
    }
  }, [fail, showToast])

  const pickPackage = async () => {
    setBusy(true)
    try {
      const res = await call(api.cliToolsPickPackage())
      if (!res.ok) fail(res.code, res.message)
      else if (res.data) setPreview(res.data)
    } finally {
      setBusy(false)
    }
  }

  const pickExternal = async () => {
    setBusy(true)
    try {
      const res = await call(api.cliToolsPickExternal())
      if (!res.ok) fail(res.code, res.message)
      else if (res.data) setExternalPick(res.data)
    } finally {
      setBusy(false)
    }
  }

  const confirmPending = async () => {
    const p = pending
    setPending(null)
    if (!p) return
    if (p.kind === 'remove-version') {
      await run(() => call(api.cliToolsRemoveVersion({ id: p.tool.id, version: p.version.version })),
        p.version.inUse ? t('Removed. Its files will be cleaned up after running tasks finish.') : t('Version removed.'))
    } else if (p.kind === 'remove-tool') {
      await run(() => call(api.cliToolsRemoveTool({ id: p.tool.id })), t('{{name}} removed.', { name: p.tool.name }))
    } else {
      setBusy(true)
      try {
        const res = await api.storeInstallCliTool({ id: p.tool.id, version: p.version })
        if (res.success) {
          showToast({ title: t('{{name}} {{version}} installed. New tasks can use it.', { name: p.tool.name, version: p.version }), variant: 'success', duration: 4000 })
        } else {
          showToast({ title: res.error || t('Install failed. Please try again.'), variant: 'error', duration: 6000 })
        }
      } finally {
        setBusy(false)
        await load()
      }
    }
  }

  if (!overview) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {loadFailed
          ? <p role="alert">{t('Failed to load command-line tools')} <button onClick={() => void load()} className="underline">{t('Retry')}</button></p>
          : <Loader2 className="h-5 w-5 animate-spin" aria-label={t('Loading…')} />}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 sm:px-10 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-3 pt-2">
        <p className="max-w-2xl text-xs text-muted-foreground">
          {t('Command-line tools on this device that tasks can call. Changes apply to tasks started afterwards; running tasks keep the tools they started with.')}
        </p>
        <div className="flex flex-wrap gap-2">
          <button disabled={busy || !overview.available} onClick={() => void pickPackage()}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            <PackagePlus className="h-4 w-4" />{t('Import package')}
          </button>
          <button disabled={busy || !overview.available} onClick={() => void pickExternal()}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] hover:bg-secondary disabled:opacity-50">
            <FilePlus2 className="h-4 w-4" />{t('Add existing program')}
          </button>
        </div>
      </div>

      {overview.signature !== 'on' && (
        <div role="note" className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
          <ShieldOff className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            {overview.signature === 'off'
              ? t('Signature verification is not enabled on this build. Catalog packages are checked against the catalog digest only.')
              : t('The trusted signing keys of this build are unusable, so installs from the enterprise catalog are refused.')}
          </span>
        </div>
      )}
      {overview.pendingCleanup > 0 && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {t('{{count}} removed version(s) are still used by running tasks and will be cleaned up when Halo next starts.', { count: overview.pendingCleanup })}
        </p>
      )}

      {!overview.available ? (
        <p className="mt-6 text-sm text-muted-foreground">{t('Command-line tools are not available in this window.')}</p>
      ) : overview.tools.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-2 text-center">
          <SquareTerminal className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">{t('No command-line tools yet')}</p>
          <p className="max-w-sm text-xs text-muted-foreground">{t('Install one from the enterprise store, import a .hcli package, or add a program already on this computer.')}</p>
        </div>
      ) : (
        <ul className="mt-3 grid gap-3 lg:grid-cols-2">
          {overview.tools.map(tool => (
            <CliToolCard key={tool.id} tool={tool} busy={busy}
              onSetCurrent={version => void run(() => call(api.cliToolsSetCurrent({ id: tool.id, version })),
                t('{{name}} now uses {{version}} for new tasks.', { name: tool.name, version }))}
              onToggle={() => void run(() => call(api.cliToolsSetDisabled({ id: tool.id, disabled: !tool.disabled })))}
              onReconfirm={() => void run(() => call(api.cliToolsReconfirmExternal({ id: tool.id })), t('Program re-confirmed. New tasks can use it.'))}
              onRemoveVersion={version => setPending({ kind: 'remove-version', tool, version })}
              onRemoveTool={() => setPending({ kind: 'remove-tool', tool })}
              onUpdate={version => setPending({ kind: 'update', tool, version })}
            />
          ))}
        </ul>
      )}

      {pending && (
        <ConfirmDialog
          variant={pending.kind === 'update' ? 'default' : 'danger'}
          title={pending.kind === 'update'
            ? t('Update {{name}} to {{version}}?', { name: pending.tool.name, version: pending.version })
            : pending.kind === 'remove-tool'
              ? t('Remove {{name}}?', { name: pending.tool.name })
              : t('Delete version {{version}}?', { version: pending.version.version })}
          message={pending.kind === 'update'
            ? t('The package is downloaded from the enterprise catalog and verified. Running tasks keep the version they started with.')
            : pending.kind === 'remove-tool'
              ? t('All versions are removed. Files still used by running tasks are cleaned up later. A registered program file on your computer is not deleted.')
              : pending.version.source === 'external'
                ? t('Only the registration is removed. The program file on your computer is not deleted.')
                : t('Files still used by running tasks are cleaned up later.')}
          confirmLabel={pending.kind === 'update' ? t('Download and install') : t('Delete')}
          cancelLabel={t('Cancel')}
          onConfirm={() => void confirmPending()}
          onCancel={() => setPending(null)}
        />
      )}
      {preview && (
        <CliImportDialog preview={preview}
          onClose={() => { void api.cliToolsCancelImport({ previewId: preview.previewId }); setPreview(null) }}
          onConfirm={async makeCurrent => {
            const ok = await run(() => call(api.cliToolsConfirmImport({ previewId: preview.previewId, makeCurrent })),
              t('{{name}} {{version}} imported.', { name: preview.name, version: preview.version }))
            setPreview(null)
            return ok
          }}
        />
      )}
      {externalPick && (
        <CliExternalDialog pick={externalPick}
          onClose={() => setExternalPick(null)}
          onSubmit={async input => {
            const res = await call(api.cliToolsRegisterExternal({ pickId: externalPick.pickId, ...input }))
            if (res.ok) {
              setOverview(res.data)
              setExternalPick(null)
              showToast({ title: t('Program added. New tasks can call it as {{command}}.', { command: input.command }), variant: 'success', duration: 4000 })
              return null
            }
            if (res.code === 'EXPIRED') setExternalPick(null)
            return cliToolsErrorText(t, res.code, res.message)
          }}
        />
      )}
    </div>
  )
}

function CliToolCard({ tool, busy, onSetCurrent, onToggle, onReconfirm, onRemoveVersion, onRemoveTool, onUpdate }: {
  tool: CliToolView
  busy: boolean
  onSetCurrent: (version: string) => void
  onToggle: () => void
  onReconfirm: () => void
  onRemoveVersion: (version: CliToolVersionView) => void
  onRemoveTool: () => void
  onUpdate: (version: string) => void
}) {
  const { t } = useTranslation()
  const currentView = tool.versions.find(v => v.current)
  const changed = currentView?.external?.changed
  return (
    <li className="rounded-xl border border-border bg-card p-4" data-testid={`cli-tool-${tool.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{tool.name}</h3>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{tool.id}</p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClass(tool.status)}`}>{statusLabel(t, tool.status)}</span>
      </div>
      {tool.description && <p className="mt-1.5 text-xs text-muted-foreground">{tool.description}</p>}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t('Commands')}</dt>
        <dd className="flex flex-wrap gap-1">
          {tool.commands.length ? tool.commands.map(c => <code key={c} className="rounded bg-secondary px-1.5 py-0.5 text-[11px]">{c}</code>) : '—'}
        </dd>
        <dt className="text-muted-foreground">{t('Current version')}</dt>
        <dd>{tool.current === null ? '—' : currentView?.source === 'external' ? t('Existing program') : tool.current}{currentView && currentView.source !== 'external' && <span className="text-muted-foreground"> · {sourceLabel(t, currentView.source)}</span>}</dd>
        {tool.skill && (
          <>
            <dt className="text-muted-foreground">{t('AI skill')}</dt>
            <dd className="min-w-0 break-words" data-testid={`cli-tool-skill-${tool.id}`}>
              {tool.skill.description}
              {' · '}
              <span className="whitespace-nowrap text-muted-foreground">{skillSourceLabel(t, tool.skill.source)}</span>
            </dd>
          </>
        )}
      </dl>

      {tool.status === 'revoked' && <p className="mt-2 text-xs text-halo-error">{t('Revoked by your administrator. New tasks can no longer use it.')}</p>}
      {tool.status === 'delisted' && <p className="mt-2 text-xs text-halo-error">{t('No longer offered by the enterprise catalog. New tasks can no longer use it; you can switch to a version from another source.')}</p>}
      {changed && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-halo-warning/10 px-3 py-2 text-xs text-halo-warning">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span className="flex-1">{changed === 'missing'
            ? t('The program file is missing. New tasks will not use it until you re-confirm.')
            : t('The program changed after you added it. New tasks will not use it until you re-confirm.')}</span>
          <button disabled={busy} onClick={onReconfirm} className="rounded-md border border-current px-2 py-1 font-medium disabled:opacity-50">{t('Re-confirm')}</button>
        </div>
      )}
      {tool.catalogUpdate && tool.status !== 'revoked' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-xs">
          <span className="flex-1">{t('Update available: {{version}}', { version: tool.catalogUpdate })}</span>
          <button disabled={busy} onClick={() => onUpdate(tool.catalogUpdate!)} className="rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground disabled:opacity-50">{t('Update')}</button>
        </div>
      )}

      <div className="mt-3 border-t border-border-faint pt-2">
        <p className="mb-1 text-[11px] text-muted-foreground">{t('Installed versions. Switching applies only to tasks started afterwards.')}</p>
        <ul className="space-y-1">
          {tool.versions.map(v => (
            <li key={v.version} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1 py-1 text-xs">
              <span className="font-mono">{v.source === 'external' ? t('Existing program') : v.version}</span>
              {v.source !== 'external' && <span className="text-muted-foreground">{sourceLabel(t, v.source)}</span>}
              {v.current && <span className="rounded bg-secondary px-1.5 text-[11px]">{t('Current')}</span>}
              {v.withdrawn && <span className="rounded bg-halo-warning/10 px-1.5 text-[11px] text-halo-warning">{t('Withdrawn')}</span>}
              {v.inUse && <span className="rounded bg-secondary px-1.5 text-[11px] text-muted-foreground">{t('In use by a task')}</span>}
              <span className="ml-auto flex gap-2">
                {!v.current && !(v.external?.changed) && (
                  <button disabled={busy} onClick={() => onSetCurrent(v.version)} className="text-primary hover:underline disabled:opacity-50">{t('Set as current')}</button>
                )}
                {v.removable && (
                  <button disabled={busy} onClick={() => onRemoveVersion(v)} className="text-halo-error hover:underline disabled:opacity-50">{v.source === 'external' ? t('Remove registration') : t('Delete')}</button>
                )}
              </span>
              {v.external && (
                <div className="w-full pl-1 text-[11px] text-muted-foreground">
                  <p className="break-all font-mono">{v.external.path}{v.external.interpreter === 'halo-node' ? ` · ${t('runs on Halo\'s Node.js')}` : ''}</p>
                  <p className="text-halo-warning">{t('Not managed by Halo; its dependencies may be updated outside Halo.')}</p>
                </div>
              )}
              {v.withdrawn && <p className="w-full pl-1 text-[11px] text-muted-foreground">{t('The catalog no longer offers this version. It still works; consider updating.')}</p>}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        <button disabled={busy || tool.current === null} onClick={onToggle} className="text-foreground hover:underline disabled:opacity-50">
          {tool.disabled ? t('Enable') : t('Disable')}
        </button>
        {tool.hasPreset
          ? <span className="text-muted-foreground">{t('Shipped with Halo: can be disabled, not removed.')}</span>
          : <button disabled={busy} onClick={onRemoveTool} className="text-halo-error hover:underline disabled:opacity-50">{t('Remove tool')}</button>}
      </div>
    </li>
  )
}
