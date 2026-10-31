import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { useAppStore } from '../../stores/app.store'
import { useEngineId } from '../../stores/engine.store'
import { useAppsStore } from '../../stores/apps.store'
import { useActiveModelTarget, type ActiveModelTarget } from '../../hooks/useActiveModelTarget'
import { useEngineAvailability } from '../../hooks/useEngineAvailability'
import { saveConversationEngineOverride } from '../../hooks/useConversationEngine'
import { openPersonModelSettings } from '../../utils/people-navigation'
import { ModelSelectSheet } from '../ai-config/ModelSelector'
import { resolveModelSelection } from '../../types'
import type { EngineId } from '../../../shared/types/engine'
import { getEngineSourceCompatibility } from '../../../shared/engine-source'
import { resolveEngineIssue, resolveEngineNotice } from './engine-issue'

/**
 * What the chat says when its engine or account cannot run here, with the ways
 * out: set up Claude Code, move this conversation (or digital human) to an
 * engine that can run, or pick another account.
 */
export function EngineRecoveryNotice({ engineId, spaceId, failure, target: explicitTarget }: {
  engineId?: EngineId
  spaceId?: string | null
  /** Why the last turn failed, when it failed because its engine or account cannot run here. */
  failure?: string | null
  /** Defaults to the conversation on screen. */
  target?: ActiveModelTarget
}) {
  const { t } = useTranslation()
  const engine = useEngineId(engineId)
  const requested = useAppStore(state => state.config?.agent?.sdkEngine)
  const sources = useAppStore(state => state.config?.aiSources)
  const navigate = useAppStore(state => state.navigate)
  const openClaudeCodeSettings = useAppStore(state => state.openClaudeCodeSettings)
  const activeTarget = useActiveModelTarget()
  const target = explicitTarget ?? activeTarget
  const [dismissed, setDismissed] = useState(false)
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const selected = sources?.version === 2
    ? resolveModelSelection(sources, target.kind === 'conversation' ? target.conversation : target).source
    : undefined
  const delegated = !getEngineSourceCompatibility('halo', selected).compatible
  const availability = useEngineAvailability(engine === 'anthropic' || delegated || Boolean(failure), failure)
  const ccAvailable = availability ? Boolean(availability.engines.find(item => item.engineId === 'anthropic')?.available) : undefined
  const accountCompatibility = engine ? getEngineSourceCompatibility(engine, selected) : { compatible: true as const }
  const fellBack = !engineId && requested === 'anthropic' && engine === 'halo'
  const canMove = target.kind === 'digital-human' || Boolean(spaceId && target.conversation)

  const issue = engine ? resolveEngineIssue({ engine, delegated, accountCompatible: accountCompatibility.compatible, ccAvailable }) : null
  const notice = resolveEngineNotice({ issue, failed: Boolean(failure), fellBack, dismissed })
  if (!notice) return null

  const moveTo = async (next: EngineId) => {
    setSaving(true)
    setFailed(false)
    try {
      const saved = target.kind === 'digital-human'
        ? await useAppsStore.getState().updateAppOverrides(target.appId, { engineId: next })
        : target.conversation && spaceId ? await saveConversationEngineOverride(spaceId, target.conversation.id, next) === null : false
      if (!saved) setFailed(true)
    } finally { setSaving(false) }
  }
  const pickAccount = () => {
    if (target.kind === 'digital-human') openPersonModelSettings(target.appId)
    else setPicking(true)
  }

  const message = issue === 'account-needs-cc'
    ? t('This account signs in through Claude Code. Connect Claude Code first, or use another account.')
    : issue === 'account-cc-ready'
      ? t('This account signs in through Claude Code. Run this conversation on Claude Code, or use another account.')
      : issue === 'codex-account'
        ? t('Codex supports OpenAI-compatible Chat Completions and Responses accounts. Choose another account or another engine.')
        : issue === 'cc-missing'
          ? t('This conversation runs on Claude Code, which is not available on this computer. Install or connect Claude Code, or continue with Halo SDK.')
          : notice.kind === 'failure'
            ? t('This conversation’s engine or account cannot run on this computer. Check the engine and account in Settings.')
            : t('Halo SDK is currently running. To use Claude Code, connect it in Settings > Advanced. Your chat history is kept; no restart is needed.')
  const action = 'min-h-11 rounded-md px-2.5 py-1.5 font-medium text-primary hover:bg-primary/10 disabled:opacity-50 sm:min-h-0 sm:px-0 sm:py-0 sm:hover:bg-transparent sm:hover:underline'

  return (
    <div className="mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-halo-warning/30 bg-halo-warning/10 p-3 text-xs sm:mx-4" role="status">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-halo-warning" />
      <div className="min-w-0 flex-1 space-y-1">
        <p>{message}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {/* Claude Code is set up on the computer running Halo; remote clients have no such settings. */}
          {(issue === 'account-needs-cc' || issue === 'cc-missing') && !api.isRemoteMode() && (
            <button type="button" className={action} onClick={openClaudeCodeSettings}>
              {issue === 'cc-missing' ? t('Install or connect Claude Code') : t('Set up Claude Code')}
            </button>
          )}
          {issue === 'account-cc-ready' && canMove && (
            <button type="button" className={action} disabled={saving} onClick={() => void moveTo('anthropic')}>{t('Use Claude Code')}</button>
          )}
          {issue === 'cc-missing' && canMove && (
            <button type="button" className={action} disabled={saving} onClick={() => void moveTo('halo')}>{t('Continue with Halo SDK')}</button>
          )}
          {(issue === 'account-needs-cc' || issue === 'account-cc-ready' || issue === 'codex-account') && (
            <button type="button" className={action} onClick={pickAccount}>{t('Use another account')}</button>
          )}
          {!issue && <button type="button" className={action} onClick={() => navigate('settings')}>{t('Open Settings')}</button>}
        </div>
        {failed && <p role="alert" className="text-destructive">{t('The engine selection could not be saved. Please try again.')}</p>}
      </div>
      {notice.kind === 'fell-back' && <button type="button" className="rounded p-1 hover:bg-muted" aria-label={t('Hide for now')} onClick={() => setDismissed(true)}><X className="h-4 w-4" /></button>}
      {picking && <ModelSelectSheet onClose={() => setPicking(false)} />}
    </div>
  )
}
