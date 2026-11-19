/**
 * The two trust decisions of the local tool manager.
 *
 * Import: the main process has already unpacked and validated the package in
 * a staging folder — nothing from it ran — and this dialog shows what it
 * claims before the user decides to trust it.
 *
 * Existing program: Halo only records where the program is and its
 * fingerprint; the file is never copied or changed.
 */

import { useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { getCurrentLanguage, useTranslation } from '../../i18n'
import { CapabilityDialog } from './CapabilityDialog'
import { sourceLabel } from './cli-tools-labels'
import type { CliExternalPick, CliPackagePreviewView } from '../../../shared/types/cli-tools'

function formatSize(bytes: number): string {
  const units = ['byte', 'kilobyte', 'megabyte'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return new Intl.NumberFormat(getCurrentLanguage(), {
    style: 'unit', unit: units[unit], unitDisplay: 'short', maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value)
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

export function CliImportDialog({ preview, onClose, onConfirm }: {
  preview: CliPackagePreviewView
  onClose: () => void
  onConfirm: (makeCurrent: boolean) => Promise<boolean>
}) {
  const { t } = useTranslation()
  const hasCurrent = !!preview.existing?.current
  // An existing choice from another source is kept unless the user asks.
  const [makeCurrent, setMakeCurrent] = useState(!hasCurrent)
  const [working, setWorking] = useState(false)
  const blocked = preview.sameVersion !== null

  const sideEffects = preview.sideEffects === 'read-only' ? t('Read-only') : preview.sideEffects === 'writes' ? t('Can change data') : t('Not declared')
  const auth = preview.auth === 'none' ? t('No sign-in needed') : preview.auth === 'env-ref' ? t('Uses a configured credential') : preview.auth === 'external-login' ? t('Signs in on its own') : t('Not declared')

  return (
    <CapabilityDialog title={t('Import command-line tool')} onClose={onClose}>
      <div className="space-y-3 p-4 text-sm" data-testid="cli-import-preview">
        <div className="flex items-start gap-2 rounded-lg bg-halo-warning/10 px-3 py-2 text-xs text-halo-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>{t('Not signed by your enterprise. Import it only if you trust where it came from. Nothing in the package has run yet.')}</span>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <Row label={t('Source')}>{t('Imported by you')} · <span className="font-mono">{preview.fileName}</span></Row>
          <Row label={t('Name')}>{preview.name}</Row>
          <Row label={t('Tool ID')}><span className="font-mono">{preview.id}</span></Row>
          <Row label={t('Version')}>{preview.version}</Row>
          <Row label={t('Commands')}>
            <ul className="space-y-0.5">
              {preview.commands.map(c => (
                <li key={c.name}>
                  <code className="rounded bg-secondary px-1.5 py-0.5 text-[11px]">{c.name}</code>
                  {c.clash === 'tool' && <span className="ml-2 text-halo-warning">{t('Same name as a command of another installed tool')}</span>}
                  {c.clash === 'path' && <span className="ml-2 text-halo-warning">{t('Same name as a program already on this computer; tasks will use this tool')}</span>}
                </li>
              ))}
            </ul>
          </Row>
          <Row label={t('Platforms')}>{preview.platforms.join(', ')}</Row>
          <Row label={t('Minimum Node.js')}>{preview.minNode ?? t('Not declared')}</Row>
          <Row label={t('Side effects')}>{sideEffects}</Row>
          <Row label={t('Sign-in')}>{auth}</Row>
          <Row label={t('Size')}>{t('{{archive}} package, {{payload}} unpacked, {{files}} files', { archive: formatSize(preview.archiveBytes), payload: formatSize(preview.payloadBytes), files: preview.files })}</Row>
        </dl>
        {preview.description && <p className="text-xs text-muted-foreground">{preview.description}</p>}

        {preview.sameVersion === 'identical' && <p className="text-xs text-muted-foreground">{t('This exact version is already installed.')}</p>}
        {preview.sameVersion === 'conflict' && (
          <p role="alert" className="text-xs text-halo-error">{t('This version number is already installed with different content. Versions are immutable: ask the publisher for a new version number, or delete the installed one first.')}</p>
        )}
        {!blocked && hasCurrent && (
          <div className="rounded-lg border border-border px-3 py-2 text-xs">
            <p>{t('This tool already uses {{version}} ({{source}}). Importing keeps that choice unless you set this one as current.', {
              version: preview.existing!.currentSource === 'external' ? t('Existing program') : preview.existing!.current,
              source: preview.existing!.currentSource ? sourceLabel(t, preview.existing!.currentSource) : '',
            })}</p>
            <label className="mt-1.5 flex items-center gap-2">
              <input type="checkbox" checked={makeCurrent} onChange={e => setMakeCurrent(e.target.checked)} />
              {t('Set as current (applies to tasks started afterwards)')}
            </label>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="min-h-9 rounded-lg border border-border px-3 text-[13px] hover:bg-secondary">{t('Cancel')}</button>
          <button disabled={blocked || working}
            onClick={async () => { setWorking(true); try { await onConfirm(makeCurrent) } finally { setWorking(false) } }}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground disabled:opacity-50">
            {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{t('Trust and import')}
          </button>
        </div>
      </div>
    </CapabilityDialog>
  )
}

/** Same rule as the store: lowercase name, no `halo-` prefix (reserved for Halo's own commands). */
const COMMAND_PATTERN = /^(?!halo-)[a-z0-9][a-z0-9._-]{0,63}$/

export function CliExternalDialog({ pick, onClose, onSubmit }: {
  pick: CliExternalPick
  onClose: () => void
  /** Answers an error text, or null on success. */
  onSubmit: (input: { command: string; name: string; description?: string }) => Promise<string | null>
}) {
  const { t } = useTranslation()
  const [command, setCommand] = useState(pick.suggestedCommand)
  const [name, setName] = useState(pick.fileName)
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const commandValid = COMMAND_PATTERN.test(command)

  return (
    <CapabilityDialog title={t('Add existing program')} onClose={onClose}>
      <form className="space-y-3 p-4 text-sm" data-testid="cli-external-form"
        onSubmit={async e => {
          e.preventDefault()
          if (!commandValid || !name.trim()) return
          setWorking(true)
          try {
            setError(await onSubmit({ command, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }))
          } finally {
            setWorking(false)
          }
        }}>
        <div className="flex items-start gap-2 rounded-lg bg-halo-warning/10 px-3 py-2 text-xs text-halo-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>{t('Not managed by Halo; its dependencies may be updated outside Halo. Halo only records its location and fingerprint, and never copies, changes or deletes the file. If the file changes, tasks stop using it until you re-confirm.')}</span>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <Row label={t('Program')}><span className="break-all font-mono">{pick.path}</span></Row>
          <Row label={t('Runs with')}>{pick.interpreter === 'halo-node' ? t('Halo\'s bundled Node.js') : t('Runs directly')}</Row>
        </dl>
        <label className="block text-xs">
          <span className="text-muted-foreground">{t('Command name')}</span>
          <input value={command} onChange={e => setCommand(e.target.value.trim())} aria-invalid={!commandValid}
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm" />
          {!commandValid && <span className="mt-1 block text-halo-error">{t('Use lowercase letters, digits, dot, dash or underscore (up to 64), not starting with "halo-".')}</span>}
        </label>
        <label className="block text-xs">
          <span className="text-muted-foreground">{t('Display name')}</span>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={128}
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        </label>
        <label className="block text-xs">
          <span className="text-muted-foreground">{t('Description (optional)')}</span>
          <textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={1024} rows={2}
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        </label>
        {error && <p role="alert" className="text-xs text-halo-error">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="min-h-9 rounded-lg border border-border px-3 text-[13px] hover:bg-secondary">{t('Cancel')}</button>
          <button type="submit" disabled={!commandValid || !name.trim() || working}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground disabled:opacity-50">
            {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{t('Add program')}
          </button>
        </div>
      </form>
    </CapabilityDialog>
  )
}
