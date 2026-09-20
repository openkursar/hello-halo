import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from '../../i18n'

export function CapabilityDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
    return () => { ref.current?.close() }
  }, [])
  return (
    <dialog ref={ref} onCancel={event => { event.preventDefault(); onClose() }}
      aria-label={title} className="m-auto w-[calc(100%_-_1rem)] max-w-3xl max-h-[calc(100dvh_-_1rem)] rounded-xl border border-border bg-background text-foreground p-0 shadow-xl backdrop:bg-foreground/30">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-background px-4 py-3">
        <h2 className="font-semibold text-sm">{title}</h2>
        <button onClick={onClose} aria-label={t('Close')} className="rounded-lg p-2 hover:bg-secondary"><X className="h-4 w-4" /></button>
      </div>
      {children}
    </dialog>
  )
}
