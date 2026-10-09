/**
 * HelpHint — a "?" beside a setting that opens a short explanation of it.
 *
 * Opens on mouse hover (after a short delay, so passing over it does nothing)
 * and on keyboard focus; touch screens and the remote web page have no hover,
 * so a tap opens it too. Built on Popover, so it escapes clipping containers
 * and closes on an outside click or Escape.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './Popover'

const OPEN_DELAY_MS = 200
const CLOSE_DELAY_MS = 100

// A sentence opening with a short label ("On:", or a CJK one ending in a full-width colon) starts a new line, so
// "On: … Off: …" reads as two choices instead of one paragraph. No lookbehind:
// Safari before 16.4 rejects it, and iOS 15 is still supported.
const LABELED_SENTENCE = /([。！？.!?])\s*(?=(?:[^\s。，、；：,.;:!?！？—]{1,8}|[A-Za-z]+(?: [A-Za-z]+){0,3})[：:])/g
// The label itself, so it can sit in its own column with the text wrapping beside it.
const LEADING_LABEL = /^((?:[^\s。，、；：,.;:!?！？—]{1,8}|[A-Za-z]+(?: [A-Za-z]+){0,3})[：:])\s*([\s\S]+)$/
const LINE_BREAK = '\u0000'

// Safari before 15.4 throws on `:focus-visible`; there, focus never opens the hint and a tap still does.
function isFocusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return false
  }
}

function HintLines({ text }: { text: string }) {
  const lines = text.replace(LABELED_SENTENCE, `$1${LINE_BREAK}`).split(LINE_BREAK).map(line => {
    const m = line.match(LEADING_LABEL)
    return m ? { label: m[1], body: m[2] } : { body: line }
  })
  // Choices come at least in pairs ("On: … Off: …"); a lone "Commands are not: …" is just a sentence.
  if (lines.filter(l => l.label).length < 2) return <p>{text}</p>
  // Labels share one column; an unlabeled line (a preamble) spans both.
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-1 gap-y-1">
      {lines.map((l, i) => l.label
        ? [<span key={`l${i}`} className="whitespace-nowrap">{l.label}</span>, <span key={`b${i}`}>{l.body}</span>]
        : <p key={i} className="col-span-2">{l.body}</p>)}
    </div>
  )
}

interface HelpHintProps {
  /** The explanation, a sentence or two */
  text: string
  /** Accessible name of the "?" (already translated) */
  label: string
}

export function HelpHint({ text, label }: HelpHintProps) {
  const [open, setOpen] = useState(false)
  const hovering = useRef(false)
  // Set when keyboard focus opened the hint, so the first Enter/Space confirms it instead of closing it.
  const openedByFocus = useRef(false)
  const timer = useRef<number>()

  const setLater = (next: boolean, delay: number) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(next), delay)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  // Stable, so Popover does not re-register its document listeners on every render.
  const onOpenChange = useCallback((next: boolean) => {
    openedByFocus.current = false
    setOpen(next)
  }, [])

  // Shared by the "?" and the portalled hint, so moving from one to the other keeps it open.
  const onPointerEnter = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    hovering.current = true
    setLater(true, OPEN_DELAY_MS)
  }
  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    hovering.current = false
    setLater(false, CLOSE_DELAY_MS)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <span
        className="inline-flex"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        // A click while hovered would toggle the hint shut; keep it open instead.
        onClickCapture={e => {
          if (!hovering.current) return
          e.stopPropagation()
          window.clearTimeout(timer.current)
          setOpen(true)
        }}
        onKeyDownCapture={e => {
          if ((e.key !== 'Enter' && e.key !== ' ') || !openedByFocus.current) return
          e.preventDefault()
          e.stopPropagation()
          openedByFocus.current = false
        }}
        onFocus={e => {
          if (!isFocusVisible(e.target as HTMLElement)) return
          openedByFocus.current = true
          setOpen(true)
        }}
        onBlur={() => {
          openedByFocus.current = false
          if (!hovering.current) setOpen(false)
        }}
      >
        <PopoverTrigger
          ariaLabel={label}
          className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </PopoverTrigger>
      </span>
      <PopoverContent
        align="start"
        className="max-w-xs px-3 py-2 text-xs leading-relaxed text-muted-foreground"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <HintLines text={text} />
      </PopoverContent>
    </Popover>
  )
}
