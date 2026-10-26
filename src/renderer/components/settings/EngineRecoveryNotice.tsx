import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useAppStore } from '../../stores/app.store'
import { useEngineId } from '../../stores/engine.store'
import { useActiveModelTarget } from '../../hooks/useActiveModelTarget'
import { resolveModelSelection } from '../../types'
import type { EngineId } from '../../../shared/types/engine'
import { getEngineSourceCompatibility } from '../../../shared/engine-source'

export function EngineRecoveryNotice({ engineId }: { engineId?: EngineId }) {
  const { t } = useTranslation()
  const engine = useEngineId(engineId)
  const requested = useAppStore(state => state.config?.agent?.sdkEngine)
  const sources = useAppStore(state => state.config?.aiSources)
  const navigate = useAppStore(state => state.navigate)
  const target = useActiveModelTarget()
  const [dismissed, setDismissed] = useState(false)
  const selected = sources?.version === 2
    ? resolveModelSelection(sources, target.kind === 'conversation' ? target.conversation : target).source
    : undefined
  const accountCompatibility = engine ? getEngineSourceCompatibility(engine, selected) : { compatible: true as const }
  const accountMismatch = !accountCompatibility.compatible
  const fellBack = !engineId && requested === 'anthropic' && engine === 'halo'
  if (!engine || (!accountMismatch && (!fellBack || dismissed))) return null

  return (
    <div className="mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-halo-warning/30 bg-halo-warning/10 p-3 text-xs sm:mx-4" role="status">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-halo-warning" />
      <div className="min-w-0 flex-1 space-y-1">
        <p>{!accountCompatibility.compatible
          ? accountCompatibility.code === 'delegated-requires-cc'
            ? t('This account requires Claude Code. Choose Claude Code or another model account.')
            : t('Codex supports OpenAI-compatible Chat Completions and Responses accounts. Choose another account or another engine.')
          : t('Halo SDK is currently running. To use Claude Code, connect it in Settings > Advanced. Your chat history is kept; no restart is needed.')}</p>
        <button type="button" className="font-medium text-primary hover:underline" onClick={() => navigate('settings')}>{t('Open Settings')}</button>
      </div>
      {!accountMismatch && <button type="button" className="rounded p-1 hover:bg-muted" aria-label={t('Hide for now')} onClick={() => setDismissed(true)}><X className="h-4 w-4" /></button>}
    </div>
  )
}
