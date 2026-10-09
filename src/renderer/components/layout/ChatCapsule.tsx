import { createPortal } from 'react-dom'
import { MessageCircle } from 'lucide-react'
import { useCanvasStore } from '../../stores/canvas.store'
import { useTranslation } from '../../i18n'

export function ChatCapsule() {
  const { t } = useTranslation()
  const setMaximized = useCanvasStore(state => state.setMaximized)

  return createPortal(
    <button
      type="button"
      onClick={() => setMaximized(false)}
      className="fixed left-3 top-1/2 -translate-y-1/2 z-50 w-11 h-11 flex items-center justify-center rounded-full bg-primary text-primary-foreground border border-border-faint shadow-pop hover:scale-110 active:scale-95 transition-transform duration-200"
      title={t('Return to conversation')}
      aria-label={t('Exit fullscreen and return to chat')}
    >
      <MessageCircle className="w-[22px] h-[22px]" />
    </button>,
    document.body
  )
}
