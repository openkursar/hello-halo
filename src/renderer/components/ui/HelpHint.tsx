/**
 * HelpHint — a "?" beside a setting that opens a short explanation of it.
 *
 * Opens on click, not hover: phones and the remote web page have no hover, and
 * an explanation of what a setting does is read rather than glanced at. Built
 * on Popover, so it escapes clipping containers and closes on an outside click
 * or Escape.
 */

import { HelpCircle } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './Popover'

interface HelpHintProps {
  /** The explanation, a sentence or two */
  text: string
  /** Accessible name of the "?" (already translated) */
  label: string
}

export function HelpHint({ text, label }: HelpHintProps) {
  return (
    <Popover>
      <PopoverTrigger
        title={label}
        className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="max-w-xs px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        {text}
      </PopoverContent>
    </Popover>
  )
}
