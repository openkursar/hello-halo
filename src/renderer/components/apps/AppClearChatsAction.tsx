/**
 * "Clear all conversations": after a digital human's instructions or knowledge
 * changed, the history of every chat it holds — in Halo and in IM — is cleared
 * at once, as /clear clears each, so none keeps answering from what it said
 * before. It says how many conversations will go before anything does, and
 * which it leaves alone (IM chats a team answers).
 */

import { useState } from 'react'
import { AlertTriangle, Eraser, Loader2 } from 'lucide-react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'

type ClearState =
  | { step: 'idle' }
  | { step: 'counting' }
  | { step: 'nothing' }
  | { step: 'confirm'; total: number; im: number; teamIm: number }
  | { step: 'clearing' }
  | { step: 'done'; cleared: number; failed: number }
  | { step: 'failed'; error: string }

export function AppClearChatsAction({ appId }: { appId: string }) {
  const { t } = useTranslation()
  const [state, setState] = useState<ClearState>({ step: 'idle' })

  async function askToClear() {
    setState({ step: 'counting' })
    const res = await api.appChatsClearable(appId)
    if (!res.success || !res.data) {
      setState({ step: 'failed', error: res.error ?? '' })
      return
    }
    setState(res.data.total === 0
      ? { step: 'nothing' }
      : { step: 'confirm', total: res.data.total, im: res.data.im, teamIm: res.data.teamIm ?? 0 })
  }

  async function clearAll() {
    setState({ step: 'clearing' })
    const res = await api.appChatsClearAll(appId)
    setState(res.success && res.data
      ? { step: 'done', cleared: res.data.cleared, failed: res.data.failed }
      : { step: 'failed', error: res.error ?? '' })
  }

  if (state.step === 'confirm' || state.step === 'clearing') {
    const clearing = state.step === 'clearing'
    return (
      <div className="p-3 border border-orange-400/30 rounded-lg space-y-2">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-muted-foreground">
            {state.step === 'confirm'
              ? t('Clear the history of {{count}} conversation(s), {{im}} of them in IM? Each starts afresh with its next message, and replies in progress stop. This cannot be undone. Memory and reminders are kept.', { count: state.total, im: state.im })
              : t('Clearing…')}
            {state.step === 'confirm' && state.teamIm > 0 && (
              <>{' '}{t('IM conversations a team answers are not included ({{count}}); to clear one, send /clear in it.', { count: state.teamIm })}</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void clearAll()}
            disabled={clearing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-orange-400 hover:text-orange-300 border border-orange-400/30 hover:border-orange-400/60 rounded-lg transition-colors disabled:opacity-50"
          >
            {clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eraser className="w-3.5 h-3.5" />}
            {t('Confirm Clear')}
          </button>
          <button
            onClick={() => setState({ step: 'idle' })}
            disabled={clearing}
            className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-lg transition-colors disabled:opacity-50"
          >
            {t('Cancel')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <button
        onClick={() => void askToClear()}
        disabled={state.step === 'counting'}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-orange-400 hover:text-orange-300 border border-orange-400/30 hover:border-orange-400/60 rounded-lg transition-colors disabled:opacity-50"
      >
        {state.step === 'counting' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eraser className="w-4 h-4" />}
        {t('Clear all conversations')}
      </button>
      <p className="text-[11px] text-muted-foreground/60">
        {t('Clears the history of all its conversations, in Halo and in IM, as /clear does in each. Use it after changing its instructions or knowledge so no conversation keeps answering from before.')}
      </p>
      {state.step === 'nothing' && <p className="text-xs text-muted-foreground">{t('No conversation has history to clear.')}</p>}
      {state.step === 'done' && (
        <p className={`text-xs ${state.failed > 0 ? 'text-destructive' : 'text-green-500'}`}>
          {state.failed > 0
            ? t('Cleared {{count}} conversation(s); {{failed}} could not be cleared. Try again.', { count: state.cleared, failed: state.failed })
            : t('Cleared {{count}} conversation(s).', { count: state.cleared })}
        </p>
      )}
      {state.step === 'failed' && (
        <p className="text-xs text-destructive">{t('Could not clear the conversations: {{error}}', { error: state.error })}</p>
      )}
    </div>
  )
}
