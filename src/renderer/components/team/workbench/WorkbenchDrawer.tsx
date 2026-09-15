import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useTranslation } from '../../../i18n'

export function WorkbenchDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation()
  const id = useId()
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, summary, a[href], [tabindex="0"]') ?? [])
        .filter(node => node.getClientRects().length > 0)
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true); previous?.focus() }
  }, [])
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-background/60 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id} className="flex h-full w-full max-w-lg flex-col border-l border-border bg-background shadow-xl outline-none">
        <header className="flex shrink-0 items-center justify-between border-b border-border p-4 pt-12 sm:pt-12">
          <h2 id={id} className="font-medium">{title}</h2>
          <button onClick={onClose} aria-label={t('Close')} className="rounded-lg p-2 hover:bg-secondary"><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </section>
    </div>, document.body,
  )
}
