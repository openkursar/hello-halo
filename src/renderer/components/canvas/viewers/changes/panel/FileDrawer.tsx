/**
 * The file list as a drawer over a narrow view: a modal dialog that keeps Tab
 * inside, closes on Esc or a click outside, and gives focus back to the
 * button that opened it — unless closing sent focus somewhere on purpose (a
 * picked file's card). The list inside takes focus when it appears.
 */

import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useTranslation } from '../../../../../i18n'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface FileDrawerProps {
  /** Phone-sized view: the drawer covers the whole width. */
  fullWidth: boolean
  onClose: () => void
  opener: RefObject<HTMLElement | null>
  children: ReactNode
}

export function FileDrawer({ fullWidth, onClose, opener, children }: FileDrawerProps) {
  const { t } = useTranslation()
  const drawerRef = useRef<HTMLElement>(null)

  useEffect(() => () => {
    const active = document.activeElement
    if (!active || active === document.body) opener.current?.focus({ preventScroll: true })
  }, [opener])

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const items = [...(drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((item) => item.offsetParent !== null)
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <>
      <div className="absolute inset-0 z-30 bg-black/30" onClick={onClose} aria-hidden />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('File list')}
        onKeyDown={onKeyDown}
        className={`absolute inset-y-0 right-0 z-40 flex min-h-0 flex-col border-l border-border shadow-pop ${fullWidth ? 'w-full' : 'w-[min(86%,340px)]'}`}
      >
        {children}
      </aside>
    </>
  )
}
