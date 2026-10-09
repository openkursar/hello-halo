/**
 * The processing-notice switch of one IM channel instance, shared by every
 * provider's card for the same reason ImInstancePermissionSection is: one
 * setting, one meaning, one place that says what it does.
 *
 * The notice exists for a reply sent as one message. A stream shows the same
 * status in the reply itself, so while streaming is on the switch is shown as
 * it stands but cannot be changed, and says why.
 */

import { useTranslation } from '../../i18n'
import { HelpHint } from '../ui/HelpHint'
import { Switch, switchRowHover } from '../ui/Switch'

interface ImProcessingNoticeRowProps {
  /** The stored choice: on unless explicitly turned off */
  on: boolean
  /** Whether replies stream, which makes the notice moot */
  streaming: boolean
  onToggle: () => void
}

export function ImProcessingNoticeRow({ on, streaming, onToggle }: ImProcessingNoticeRowProps) {
  const { t } = useTranslation()
  return (
    <div className={`flex items-center justify-between gap-3 py-1.5 ${switchRowHover}`}>
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-1">
          <p className="text-sm text-foreground">{t('Processing Notice')}</p>
          <HelpHint
            label={t('About this setting')}
            text={t('Only applies while streaming is off. On: if there is no reply within 5 seconds, a short "received, working on it" notice is sent first, so the sender knows the message arrived. Off: only the final reply is sent.')}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {streaming
            ? t('Streaming already shows this status in the reply itself')
            : on
              ? t('Sends "received, working on it" when a reply takes over 5 seconds')
              : t('Only sends the final reply')}
        </p>
      </div>
      <Switch checked={on} disabled={streaming} onCheckedChange={onToggle} />
    </div>
  )
}
