import { useEffect, useRef, useState } from 'react'
import { ChevronRight, FolderOpen, Loader2, Search } from 'lucide-react'
import type { RuntimeId, RuntimeInstallation as CcInstallation, RuntimeScanResult as CcScanResult } from '../../../../shared/types/external-runtime'
import { api } from '../../../api'
import { useTranslation } from '../../../i18n'
import { RuntimeInstallationList } from './InstallationList'
import { useRuntimeMessages } from './messages'
import { ccIssue, ccResult } from './response'
import { RuntimeButton, runtimeInputClass } from './ui'

interface Props {
  runtimeId: RuntimeId
  busy: boolean
  busyPath?: string
  selectedPath?: string
  knownPaths: string[]
  onScan: () => Promise<CcScanResult | undefined>
  onProbe: (path: string) => Promise<CcInstallation | undefined>
  onSelect: (item: CcInstallation) => void
  /** Increments when another panel asks for a scan; the panel opens and scans. */
  scanRequest?: number
}

export function RuntimeLocalPanel({ runtimeId, busy, busyPath, selectedPath, knownPaths, onScan, onProbe, onSelect, scanRequest }: Props) {
  const { t } = useTranslation()
  const messages = useRuntimeMessages(runtimeId)
  const [path, setPath] = useState('')
  const [found, setFound] = useState<CcInstallation[]>([])
  const [scanned, setScanned] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [operation, setOperation] = useState<'scan' | 'browse' | 'check' | null>(null)
  const [checkedPath, setCheckedPath] = useState<string | null>(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const run = async (kind: NonNullable<typeof operation>, task: () => Promise<void>) => {
    if (busy || pending.current) return
    pending.current = true
    setOperation(kind)
    setPickerError(null)
    try { await task() }
    catch (error) {
      if (mounted.current) setPickerError(messages.issue(ccIssue(error)))
    } finally {
      pending.current = false
      if (mounted.current) setOperation(null)
    }
  }

  const inspect = async (value: string) => {
    setScanned(false)
    setTruncated(false)
    setCheckedPath(null)
    const result = await onProbe(value.trim())
    if (result && mounted.current) {
      setFound(previous => [result, ...previous.filter(item => item.path !== result.path)].slice(0, 12))
      setCheckedPath(result.path)
    }
  }

  const browse = () => run('browse', async () => {
    const chosen = ccResult(await api.browseExternalRuntime(runtimeId))
    if (chosen && mounted.current) { setPath(chosen); await inspect(chosen) }
  })

  const scan = () => run('scan', async () => {
    setScanned(false)
    setTruncated(false)
    setCheckedPath(null)
    const result = await onScan()
    if (result && mounted.current) { setFound(result.installations); setScanned(true); setTruncated(result.truncated) }
  })

  const panel = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (!scanRequest || !panel.current) return
    panel.current.open = true
    panel.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    void scan()
  }, [scanRequest])

  const candidates = found.filter(item => !knownPaths.includes(item.path))
  const blocked = busy || operation !== null

  return <details ref={panel} className="group/local border-t border-border pt-3">
    <summary className="flex cursor-pointer list-none items-center gap-2 rounded py-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
      <FolderOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />{t('Connect local installation')}
      <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open/local:rotate-90" />
    </summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">{runtimeId === 'codex' ? t('Find an existing Codex installation. Halo will not change its files.') : t('Find an existing Claude Code installation. Halo will not change its files.')}</p>
      <div className="flex flex-wrap gap-2">
        <RuntimeButton primary disabled={blocked} onClick={() => void scan()}>{operation === 'scan' ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Search aria-hidden="true" className="h-4 w-4" />}{operation === 'scan' ? t('Scanning…') : t('Scan for installations')}</RuntimeButton>
        <RuntimeButton disabled={blocked} onClick={() => void browse()}>{runtimeId === 'codex' ? t('Choose local Codex') : t('Choose local Claude Code')}</RuntimeButton>
      </div>
      <details>
        <summary className="cursor-pointer rounded py-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">{t('Enter path manually')}</summary>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input className={runtimeInputClass} aria-label={runtimeId === 'codex' ? t('Codex path') : t('Claude Code path')} placeholder={t('Executable or installation folder')} value={path} disabled={blocked} onChange={event => setPath(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && !blocked && path.trim()) {
              event.preventDefault()
              void run('check', () => inspect(path))
            }
          }} />
          <RuntimeButton className="shrink-0" disabled={blocked || !path.trim()} onClick={() => void run('check', () => inspect(path))}>{operation === 'check' && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}{operation === 'check' ? t('Checking…') : t('Check path')}</RuntimeButton>
        </div>
      </details>
      {truncated && <p role="status" className="text-xs text-halo-warning">{t('The scan ended before every location could be checked. You can choose a file or enter its path directly.')}</p>}
      {scanned && !truncated && candidates.length === 0 && <p role="status" className="text-xs text-muted-foreground">{found.length > 0 ? t('The detected installations are already listed above.') : t('No additional installations found. Choose a file or enter a path.')}</p>}
      {checkedPath && knownPaths.includes(checkedPath) && <p role="status" className="text-xs text-muted-foreground">{t('The checked installation is listed above.')}</p>}
      <RuntimeInstallationList runtimeId={runtimeId} installations={candidates} selectedPath={selectedPath} busyPath={busyPath} disabled={blocked} onSelect={onSelect} onCheck={item => void run('check', () => inspect(item.path))} label={runtimeId === 'codex' ? t('Discovered Codex installations') : t('Discovered Claude Code installations')} />
      {pickerError && <p role="alert" className="text-sm text-destructive">{pickerError}</p>}
    </div>
  </details>
}
