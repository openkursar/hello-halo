import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Download, Loader2, Settings2 } from 'lucide-react'
import type { CcDownloadSource, CcInstallation, CcInstallRequest, CcReleaseInfo, CcRuntimeIssue, CcRuntimeStatus } from '../../../../shared/types/cc-runtime'
import { api } from '../../../api'
import { useTranslation } from '../../../i18n'
import { useCcRuntimeMessages } from './messages'
import { ccIssue, ccResult } from './response'
import { RuntimeButton, runtimeInputClass } from './ui'

interface Props {
  status: CcRuntimeStatus
  installing: boolean
  busy: boolean
  onInstall: (request: CcInstallRequest) => Promise<void>
  onSelect: (item: CcInstallation) => void
  onRefresh: () => Promise<CcRuntimeStatus>
  /** Look for installations on this computer instead. */
  onFindLocal: () => void
}

const normalizeVersion = (input: string) => input.trim().replace(/^v(?=\d)/i, '')
const validVersion = (input: string) => input.length <= 80 && (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input) || input === 'latest' || input === 'stable')
const usable = (item: CcInstallation) => ['unchecked', 'verified', 'compatible'].includes(item.compatibility)

export function CcDownloadPanel({ status, installing, busy, onInstall, onSelect, onRefresh, onFindLocal }: Props) {
  const { t } = useTranslation()
  const messages = useCcRuntimeMessages()
  const [version, setVersion] = useState('')
  const [sourceId, setSourceId] = useState(status.sourceId)
  const [sourceUrl, setSourceUrl] = useState(status.sources.find(source => source.id === 'custom')?.baseUrl ?? '')
  const [preview, setPreview] = useState<Pick<CcReleaseInfo, 'version' | 'installedPath' | 'size'> | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [versionFailure, setVersionFailure] = useState<{ issue?: CcRuntimeIssue } | null>(null)
  const [sourceFailure, setSourceFailure] = useState<{ issue?: CcRuntimeIssue } | null>(null)
  const revision = useRef(0)
  const mounted = useRef(true)
  const sourceDetails = useRef<HTMLDetailsElement>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const normalized = normalizeVersion(version)
  const installed = status.installations.find(item => item.version === normalized && usable(item))
  const recommended = status.installations.find(item => item.version === status.recommendedVersion && usable(item))
  const selectedRecommended = Boolean(recommended && recommended.path === status.selectedPath)
  const selectedCustom = Boolean((installed?.path ?? preview?.installedPath) && (installed?.path ?? preview?.installedPath) === status.selectedPath)
  const disabled = busy || installing || saving || checking
  // A build's own source may come without a name of its own.
  const label = (source: CcDownloadSource) => source.name || (source.id === 'preset' ? t('Default download source') : source.id)
  const current = status.sources.find(source => source.id === sourceId)
  const sourceName = sourceId === 'official' ? t('Official')
    : sourceId === 'custom' ? t('Custom source / internal mirror')
      : current ? label(current) : sourceId

  const invalidate = () => {
    revision.current++
    setPreview(null)
    setVersionFailure(null)
    setSourceFailure(null)
    setSaved(false)
  }

  const saveSource = async () => {
    const requestRevision = revision.current
    setSourceFailure(null)
    const sources = sourceId === 'custom'
      ? [...status.sources.filter(source => source.id !== 'custom'), { id: 'custom', name: t('Custom source'), baseUrl: sourceUrl.trim() }]
      : status.sources
    try {
      ccResult(await api.ccRuntimeConfigure({ sources, sourceId }))
      await onRefresh()
      if (mounted.current && requestRevision === revision.current) setSaved(true)
    } catch (error) {
      if (mounted.current && requestRevision === revision.current) {
        setSourceFailure({ issue: ccIssue(error) })
        if (sourceDetails.current) sourceDetails.current.open = true
      }
      throw error
    }
  }

  const checkVersion = async () => {
    setVersionFailure(null)
    setPreview(null)
    if (!validVersion(normalized)) { setVersionFailure({ issue: 'invalid-version' }); return }
    if (installed) {
      setPreview({ version: normalized, installedPath: installed.path })
      return
    }
    const requestRevision = revision.current
    setChecking(true)
    try {
      await saveSource()
      if (requestRevision !== revision.current) return
      const result = ccResult(await api.ccRuntimeLookup({ version: normalized, sourceId }))
      if (mounted.current && requestRevision === revision.current) setPreview(result)
    } catch (error) {
      if (mounted.current && requestRevision === revision.current) setVersionFailure({ issue: ccIssue(error) })
    } finally { if (mounted.current) setChecking(false) }
  }

  const download = async (target: string) => {
    const sources = sourceId === 'custom'
      ? [...status.sources.filter(source => source.id !== 'custom'), { id: 'custom', name: t('Custom source'), baseUrl: sourceUrl.trim() }]
      : status.sources
    await onInstall({ version: target, sourceId, preferences: { sources, sourceId } })
  }

  const sourceSettings = <details ref={sourceDetails} className="group/source border-t border-border pt-3">
    <summary className="flex cursor-pointer list-none items-center gap-2 rounded py-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
      <Settings2 className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{t('Source settings')} · {sourceName}</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 group-open/source:rotate-90" />
    </summary>
    <div className="mt-3 space-y-3">
      <label className="block space-y-1 text-xs font-medium">
        <span>{t('Download source')}</span>
        <select aria-label={t('Download source')} className={runtimeInputClass} value={sourceId} disabled={installing || saving} onChange={event => { invalidate(); setSourceId(event.target.value) }}>
          {status.sources.filter(source => source.id !== 'custom').map(source => <option key={source.id} value={source.id}>{source.id === 'official' ? t('Official (Anthropic)') : label(source)}</option>)}
          <option value="custom">{t('Custom source / internal mirror')}</option>
        </select>
      </label>
      {sourceId === 'custom' && <label className="block space-y-1 text-xs font-medium">
        <span>{t('Mirror base URL')}</span>
        <input aria-label={t('Mirror base URL')} type="url" className={runtimeInputClass} value={sourceUrl} disabled={installing || saving} onChange={event => { invalidate(); setSourceUrl(event.target.value) }} placeholder={t('URL of the Claude Code release mirror')} />
        <span className="block font-normal text-muted-foreground">{t('The mirror must provide the release manifest and files in the official download layout.')}</span>
      </label>}
      {sourceFailure && <p role="alert" className="text-xs text-destructive">{messages.issue(sourceFailure.issue)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <RuntimeButton disabled={disabled} onClick={async () => {
          setSaving(true)
          try { await saveSource() } catch { /* The field reports the failure. */ }
          finally { if (mounted.current) setSaving(false) }
        }}>{t('Save source')}</RuntimeButton>
        {saved && <span role="status" className="text-xs text-halo-success">{t('Saved')}</span>}
      </div>
    </div>
  </details>

  return <div className="space-y-3">
    <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium">{t('Recommended version: {{version}}', { version: status.recommendedVersion })}</p>
        <p className="mt-1 text-xs text-muted-foreground">{recommended ? t('Already installed. No download needed.') : t('Downloaded only when you choose to install.')}</p>
      </div>
      <RuntimeButton primary={!selectedRecommended} className="shrink-0" disabled={disabled || selectedRecommended} onClick={() => {
        if (recommended) onSelect(recommended)
        else void download(status.recommendedVersion)
      }}>
        {selectedRecommended ? <Check className="h-4 w-4" /> : <Download className="h-4 w-4" />}
        {selectedRecommended ? t('Selected') : recommended ? t('Use installed version') : t('Install recommended version')}
      </RuntimeButton>
    </div>
    <details className="group/version">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 text-muted-foreground group-open/version:rotate-90" />{t('Install another version')}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">{t('Check that this source provides the version before downloading. Compatibility is checked after installation.')}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 space-y-1 text-xs font-medium"><span>{t('Version')}</span>
            <input aria-label={t('Version')} className={runtimeInputClass} value={version} disabled={installing} placeholder={t('For example, {{version}}', { version: status.recommendedVersion })} onChange={event => { invalidate(); setVersion(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter' && !disabled) { event.preventDefault(); void checkVersion() } }} />
          </label>
          <RuntimeButton className="shrink-0" disabled={disabled || !normalized} onClick={() => void checkVersion()}>
            {checking && <Loader2 className="h-4 w-4 animate-spin" />}{t('Check version')}
          </RuntimeButton>
        </div>
        {versionFailure && <div role="alert" className="space-y-2">
          <p className="text-xs text-destructive">{messages.issue(versionFailure.issue)}</p>
          {versionFailure.issue === 'version-not-found' && <RuntimeButton disabled={disabled} onClick={onFindLocal}>{t('Find local installations')}</RuntimeButton>}
        </div>}
        {preview && <div className="space-y-2 rounded-lg border border-border p-3">
          <p role="status" className="text-sm">{installed || preview.installedPath
            ? t('Version {{version}} is already installed.', { version: preview.version })
            : t('Version {{version}} is available from this source.', { version: preview.version })}</p>
          {preview.size && !installed && <p className="text-xs text-muted-foreground">{t('Download size: {{size}} MB', { size: Math.ceil(preview.size / 1048576) })}</p>}
          <RuntimeButton primary disabled={disabled || selectedCustom} onClick={() => {
            const local = installed ?? status.installations.find(item => item.path === preview.installedPath)
            if (local) onSelect(local)
            else void download(preview.version)
          }}>{selectedCustom ? t('Selected') : installed || preview.installedPath ? t('Use installed version') : t('Install and use')}</RuntimeButton>
        </div>}
      </div>
    </details>
    {sourceSettings}
  </div>
}
