/**
 * ReplyEndingNote - the quiet line under a reply that ended before its answer
 * was done, so what it says reads as how far the work got, not as a final
 * answer. It stays with the record; the notice the chat shows right after a
 * stop (with its Continue action) takes its place while that notice is on screen.
 */

import type { ReplyEnding } from '../../../shared/types/transcript'
import { useTranslation } from '../../i18n'

// i18n static keys for extraction (DO NOT REMOVE)
// prettier-ignore
void function _i18nReplyEndings(t: (k: string) => string) {
  t('Stopped.'); t('Interrupted.'); t('Reached the step limit.')
}

const LABELS: Record<ReplyEnding, string> = {
  stopped: 'Stopped.',
  interrupted: 'Interrupted.',
  'step-limit': 'Reached the step limit.',
}

export function ReplyEndingNote({ ending, hasAnswer }: { ending: ReplyEnding; hasAnswer: boolean }) {
  const { t } = useTranslation()
  const detail = ending === 'step-limit' ? t('Send a message to continue.') : hasAnswer ? t('Above is the progress so far.') : ''
  return (
    <p className="mt-2 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{t(LABELS[ending])}</span>
      {detail && <span> {detail}</span>}
    </p>
  )
}
