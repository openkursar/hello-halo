/**
 * Switch — accessible toggle switch component.
 *
 * Uses `role="switch"` + `aria-checked` for screen-reader support.
 * Two sizes: `sm` (20×36) and `md` (24×44).
 * Colors follow theme tokens: bg-primary (checked), bg-muted (unchecked).
 */

import { cn } from '../../lib/utils'

interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  size?: 'sm' | 'md'
  className?: string
  /** What the switch turns on or off, for a switch with no visible label of its own. */
  ariaLabel?: string
}

const sizeConfig = {
  sm: {
    track: 'h-5 w-9',
    knob: 'h-4 w-4',
    knobOn: 'translate-x-[18px]',
    knobOff: 'translate-x-0.5',
    mt: 'mt-0.5',
  },
  md: {
    track: 'h-6 w-11',
    knob: 'h-5 w-5',
    knobOn: 'translate-x-[22px]',
    knobOff: 'translate-x-0.5',
    mt: 'mt-0.5',
  },
}

/**
 * Hover band for a row whose title and switch sit far apart, so the eye can
 * tie one to the other. The switch inside deepens its unchecked track at the same
 * time so the band never swallows it.
 * Bleeds 8px past the row so its text keeps aligning with the content around it.
 */
export const switchRowHover = 'group/switch-row -mx-2 px-2 rounded-md transition-colors hover:bg-foreground/[0.025]'

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  size = 'sm',
  className,
  ariaLabel,
}: SwitchProps) {
  const cfg = sizeConfig[size]

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex flex-shrink-0 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background outline-none',
        cfg.track,
        checked ? 'bg-primary' : 'bg-muted',
        !checked && !disabled && 'group-hover/switch-row:bg-muted-foreground/30',
        disabled && 'opacity-50 cursor-not-allowed',
        !disabled && 'cursor-pointer',
        className,
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block rounded-full bg-background shadow transform transition-transform',
          cfg.knob,
          cfg.mt,
          checked ? cfg.knobOn : cfg.knobOff,
        )}
      />
    </button>
  )
}
