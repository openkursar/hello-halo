import { useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { isElectron } from '../../api/transport'
import { useTranslation } from '../../i18n'
import { CcInstallationList } from './cc-runtime/InstallationList'
import { CcLocalPanel } from './cc-runtime/LocalPanel'
import { CcDownloadPanel } from './cc-runtime/DownloadPanel'
import { useCcRuntimeMessages } from './cc-runtime/messages'
import { RuntimeButton } from './cc-runtime/ui'
import { isInstalling, useCcRuntime } from './cc-runtime/use-runtime'

interface Props {
  id: string
  onUse: () => Promise<boolean>
  onClose: () => void
  configured: boolean
}

export function CcRuntimeSection(props: Props) {
  const { t } = useTranslation()
  if (!isElectron()) return <p className="px-3 pb-3 text-sm text-muted-foreground">{t('Manage Claude Code in the desktop app hosting Halo.')}</p>
  return <DesktopCcRuntimeSection {...props} />
}

function DesktopCcRuntimeSection({ id, onUse, onClose, configured }: Props) {
  const { t } = useTranslation()
  const messages = useCcRuntimeMessages()
  const runtime = useCcRuntime(onUse)
  const { status, operation, installing } = runtime
  const [localScanRequest, setLocalScanRequest] = useState(0)
  const progress = status?.install
  const percent = progress?.totalBytes ? Math.min(100, Math.round(progress.downloadedBytes / progress.totalBytes * 100)) : undefined
  const progressText = progress?.phase === 'downloading'
    ? t('Downloading: {{size}} MB', { size: ((progress.downloadedBytes ?? 0) / 1048576).toFixed(1) })
    : progress?.phase === 'verifying' ? t('Verifying download…')
      : progress?.phase === 'checking' ? t('Checking compatibility…') : t('Preparing download…')

  return <section id={id} role="region" aria-label={t('Claude Code setup')} className="min-w-0 space-y-4 border-t border-border bg-background p-3 sm:p-4">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-medium">{t('Claude Code setup')}</h3>
      <button type="button" aria-label={t('Close')} onClick={onClose} className="rounded p-1.5 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"><X aria-hidden="true" className="h-4 w-4" /></button>
    </div>
    {!configured && <p className="text-xs text-muted-foreground">{t('Choose an installation below to enable Claude Code. Halo SDK stays available while you set it up.')}</p>}
    {runtime.loading && !status && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('Loading')}</p>}
    {runtime.loadFailed && <div role="alert" className="space-y-2 text-sm text-destructive">
      <p>{t('Claude Code settings could not be loaded. Try again to refresh the installation status.')}</p>
      <RuntimeButton disabled={runtime.loading} onClick={() => void runtime.reload()}>{t('Try again')}</RuntimeButton>
    </div>}
    {status && <>
      {status.installations.length > 0 ? <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">{t('Installed versions')}</h4>
        <CcInstallationList installations={status.installations} selectedPath={status.selectedPath} busyPath={operation?.path} disabled={Boolean(operation)} onSelect={item => void runtime.select(item)} onCheck={item => void runtime.probe(item.path)} />
        {status.catalogTruncated && <p className="text-xs text-muted-foreground">{t('More installations may exist. Scan or choose a path to add one.')}</p>}
      </div> : <p className="text-sm text-muted-foreground">{t('No Claude Code installations added yet.')}</p>}
      {installing && <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{progressText}</p>
          <RuntimeButton disabled={!isInstalling(status)} onClick={() => void runtime.cancel()}>{t('Cancel')}</RuntimeButton>
        </div>
        {percent !== undefined && <div role="progressbar" aria-label={t('Download progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} /></div>}
        <p className="text-xs text-muted-foreground">{t('You can close this panel while the download continues.')}</p>
      </div>}
      {runtime.failure && <p role={runtime.failure.issue === 'cancelled' ? 'status' : 'alert'} className={`text-sm ${runtime.failure.issue === 'cancelled' ? 'text-muted-foreground' : 'text-destructive'}`}>{messages.issue(runtime.failure.issue)}</p>}
      {runtime.notice && <p role="status" className="text-xs text-muted-foreground">{runtime.notice === 'preserved'
        ? t('Claude Code is ready. Your newer engine selection has been kept.')
        : t('Claude Code is ready for new conversations. Existing conversations and running work keep their engine.')}</p>}
      <CcDownloadPanel status={status} installing={installing} busy={Boolean(operation)} onInstall={runtime.install} onSelect={item => void runtime.select(item)} onRefresh={runtime.refresh} onFindLocal={() => setLocalScanRequest(count => count + 1)} />
      <CcLocalPanel busy={Boolean(operation)} busyPath={operation?.path} selectedPath={status.selectedPath} knownPaths={status.installations.map(item => item.path)} onScan={runtime.scan} onProbe={runtime.probe} onSelect={item => void runtime.select(item)} scanRequest={localScanRequest} />
    </>}
  </section>
}
